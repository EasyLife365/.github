az login

$root = git rev-parse --show-toplevel
Set-Location "$root/_devops/automation/deployment/infrastructure"

$subscriptionId = "f167305a-9bcf-4209-a0af-b3372439a6cb" # TODO: set to the real subscription this Foundry account deploys into

./provision-environment.ps1 $subscriptionId
