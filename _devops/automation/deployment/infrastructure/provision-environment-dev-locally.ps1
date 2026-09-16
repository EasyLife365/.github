az login

$root = git rev-parse --show-toplevel
Set-Location "$root/_devops/automation/deployment/infrastructure"

$stage = "d"
$subscriptionId = "<dev-subscription-id>" # TODO: set to the sandbox/test subscription id

./provision-environment.ps1 $stage $subscriptionId
