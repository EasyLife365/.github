az login

$root = git rev-parse --show-toplevel
Set-Location "$root/_devops/automation/deployment/infrastructure"

$stage = "p"
$subscriptionId = "<production-subscription-id>" # TODO: set to the real subscription this Foundry account deploys into

./provision-environment.ps1 $stage $subscriptionId
