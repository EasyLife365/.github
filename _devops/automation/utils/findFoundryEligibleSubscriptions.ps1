# ============================================================================
# Which subscriptions can host Claude on Microsoft Foundry? — EasyLife 365
# ----------------------------------------------------------------------------
# Claude on Foundry is gated to Enterprise Agreement or MCA-Enterprise billing
# with active pay-as-you-go. Every other offer -- MCA-Individual, CSP /
# Microsoft Partner Agreement, MOSP (classic pay-as-you-go), free trial, MSDN,
# student, credit-only -- starts at 0 TPM and stays there. A quota request
# against one of those is DENIED rather than queued, because the increase form
# raises an existing allocation and there is nothing to raise.
#
# None of that is visible from the failure, which only ever says
# InsufficientQuota and names the model. So this walks every subscription you
# can see, resolves the billing account behind each one, and says which are
# worth deploying into before another request is filed.
#
# Read-only: it creates and changes nothing.
#
# Needs `az login`, plus Billing Reader (or better) on the billing accounts.
# Without that the billing lookups return nothing and rows read UNKNOWN rather
# than being wrongly cleared or condemned.
# ============================================================================

param(
    [switch]$IncludeDisabled
)

$ErrorActionPreference = 'Stop'

# Returns parsed JSON, or $null when the call fails. Deliberately does not
# throw: billingProperties legitimately 404s on some offers, and one
# subscription being unreadable must not abandon the sweep.
function Invoke-AzJson {
    param([string[]]$Arguments)

    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }

    try { return ($output | ConvertFrom-Json) }
    catch { return $null }
}

function Get-Eligibility {
    param([string]$AgreementType, [string]$AccountType, [string]$QuotaId)

    # quotaId disqualifies on its own for the offers that can never carry an
    # enterprise agreement, whatever the billing account says.
    foreach ($pattern in @('FreeTrial', 'MSDN', 'AzurePass', 'Student', 'Sponsored')) {
        if ($QuotaId -like "*$pattern*") {
            return [pscustomobject]@{ Verdict = 'NO'; Reason = "offer $QuotaId is never eligible" }
        }
    }

    switch ($AgreementType) {
        'EnterpriseAgreement' {
            return [pscustomobject]@{ Verdict = 'YES'; Reason = 'Enterprise Agreement' }
        }
        'MicrosoftCustomerAgreement' {
            # The MCA-Enterprise vs MCA-Individual split is the whole question
            # here, and it lives in accountType, not agreementType.
            switch ($AccountType) {
                'Enterprise' { return [pscustomobject]@{ Verdict = 'YES'; Reason = 'MCA-Enterprise' } }
                'Individual' { return [pscustomobject]@{ Verdict = 'NO'; Reason = 'MCA-Individual (self-signup)' } }
                'Partner'    { return [pscustomobject]@{ Verdict = 'NO'; Reason = 'MCA-Partner / CSP' } }
                default      { return [pscustomobject]@{ Verdict = 'CHECK'; Reason = 'MCA, accountType unreadable - check the portal' } }
            }
        }
        'MicrosoftPartnerAgreement' {
            return [pscustomobject]@{ Verdict = 'NO'; Reason = 'CSP' }
        }
        'MicrosoftOnlineServicesProgram' {
            return [pscustomobject]@{ Verdict = 'NO'; Reason = 'MOSP / classic pay-as-you-go' }
        }
        default {
            return [pscustomobject]@{ Verdict = 'UNKNOWN'; Reason = 'billing account not resolved' }
        }
    }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Host 'ERROR: the Azure CLI (az) is not on PATH.' -ForegroundColor Red
    exit 1
}

$null = az account show 2>&1
if (!$?) { az login }

# --- Billing accounts, indexed by id -------------------------------------
# One call up front; every subscription then resolves against this rather than
# re-querying per row.
Write-Host 'Reading billing accounts...' -ForegroundColor Cyan
$billingAccounts = @{}
$accounts = Invoke-AzJson @('billing', 'account', 'list', '-o', 'json', '--only-show-errors')

if ($null -eq $accounts) {
    Write-Host 'WARNING: could not read billing accounts. Every row will read UNKNOWN.' -ForegroundColor Yellow
    Write-Host '         You likely need Billing Reader on the billing account.' -ForegroundColor Yellow
}
else {
    foreach ($account in $accounts) {
        $billingAccounts[$account.name] = $account
        Write-Host ("  {0}  {1}{2}" -f `
            $account.displayName, `
            $account.agreementType, `
            $(if ($account.accountType) { " / $($account.accountType)" } else { '' })) -ForegroundColor DarkGray
    }
}

# --- Subscriptions --------------------------------------------------------
Write-Host 'Reading subscriptions...' -ForegroundColor Cyan
$subscriptionArgs = @('account', 'list', '-o', 'json', '--only-show-errors')
if ($IncludeDisabled) { $subscriptionArgs += '--all' }

$subscriptions = Invoke-AzJson $subscriptionArgs
if ($null -eq $subscriptions -or $subscriptions.Count -eq 0) {
    Write-Host 'ERROR: no subscriptions returned.' -ForegroundColor Red
    exit 1
}

$rows = @()

foreach ($subscription in $subscriptions) {
    if (-not $IncludeDisabled -and $subscription.state -ne 'Enabled') { continue }

    $subscriptionId = $subscription.id
    Write-Host ("  {0}" -f $subscription.name) -ForegroundColor DarkGray

    # The offer type. subscriptionPolicies.quotaId is the authoritative field;
    # `az account list` does not carry it.
    $detail = Invoke-AzJson @('rest', '--method', 'get',
        '--uri', "https://management.azure.com/subscriptions/${subscriptionId}?api-version=2020-01-01",
        '-o', 'json', '--only-show-errors')
    $quotaId = if ($detail) { $detail.subscriptionPolicies.quotaId } else { '' }

    # Which billing account pays for it. Not available on every offer, so a
    # failure here is recorded rather than fatal.
    $billing = Invoke-AzJson @('rest', '--method', 'get',
        '--uri', "https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Billing/billingProperties?api-version=2019-10-01-preview",
        '-o', 'json', '--only-show-errors')

    $billingAccountName = ''
    $agreementType = ''
    $accountType = ''

    if ($billing -and $billing.properties) {
        $billingAccountName = $billing.properties.billingAccountDisplayName

        $billingAccountId = $billing.properties.billingAccountId
        if ($billingAccountId -and $billingAccounts.ContainsKey($billingAccountId)) {
            $agreementType = $billingAccounts[$billingAccountId].agreementType
            $accountType = $billingAccounts[$billingAccountId].accountType
        }
        elseif ($billingAccountName) {
            # billingAccountId did not match a key, so fall back to matching on
            # display name -- several accounts can share one, but agreementType
            # is what matters and duplicates of that are harmless.
            $match = @($accounts | Where-Object { $_.displayName -eq $billingAccountName })
            if ($match.Count -ge 1) {
                $agreementType = $match[0].agreementType
                $accountType = $match[0].accountType
            }
        }
    }

    $eligibility = Get-Eligibility -AgreementType $agreementType -AccountType $accountType -QuotaId $quotaId

    $rows += [pscustomobject]@{
        Verdict        = $eligibility.Verdict
        Name           = $subscription.name
        SubscriptionId = $subscriptionId
        QuotaId        = $quotaId
        BillingAccount = $billingAccountName
        Agreement      = $agreementType
        AccountType    = $accountType
        Reason         = $eligibility.Reason
    }
}

Write-Host ''
$rows |
    Sort-Object @{ Expression = { @('YES', 'CHECK', 'UNKNOWN', 'NO').IndexOf($_.Verdict) } }, Name |
    Format-Table Verdict, Name, QuotaId, Agreement, AccountType, Reason -AutoSize

$eligible = @($rows | Where-Object { $_.Verdict -eq 'YES' })
$worthChecking = @($rows | Where-Object { $_.Verdict -in @('CHECK', 'UNKNOWN') })

Write-Host ''
if ($eligible.Count -gt 0) {
    Write-Host 'Deploy Foundry into one of these:' -ForegroundColor Green
    foreach ($row in $eligible) {
        Write-Host ("  {0}`n    {1}" -f $row.Name, $row.SubscriptionId) -ForegroundColor Green
    }
    Write-Host ''
    Write-Host 'Set that id in provision-environment-production-locally.ps1 and re-run it.' -ForegroundColor Green
    Write-Host 'The Entra app registration, its federated credentials and the developer group' -ForegroundColor Green
    Write-Host 'are tenant-scoped, so they carry over unchanged - nothing else needs redoing.' -ForegroundColor Green
}
else {
    Write-Host 'No subscription here is eligible for Claude on Foundry.' -ForegroundColor Yellow
    Write-Host 'Filing another quota request will not change that - the gate is the billing' -ForegroundColor Yellow
    Write-Host 'agreement, not capacity. An Enterprise Agreement or MCA-Enterprise billing' -ForegroundColor Yellow
    Write-Host 'account is a commercial conversation with your Microsoft account team.' -ForegroundColor Yellow
}

if ($worthChecking.Count -gt 0) {
    Write-Host ''
    Write-Host 'Could not be determined from the CLI - confirm these in the portal under' -ForegroundColor Yellow
    Write-Host 'Cost Management + Billing -> Billing scopes -> Properties:' -ForegroundColor Yellow
    foreach ($row in $worthChecking) {
        Write-Host ("  {0} - {1}" -f $row.Name, $row.Reason) -ForegroundColor Yellow
    }
}
