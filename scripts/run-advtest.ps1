# run-advtest.ps1 — boot an isolated verification profile with the real
# credentials, WITHOUT ever printing them.
#
# The keys are read from the user's own $DSH_HOME\.credentials.yaml and handed
# to the child process through the inherited-environment layer of the
# credentials service (the layer that ranks above the document). Nothing is
# copied, echoed, or written to disk by this script.
#
#   .\run-advtest.ps1 -Profile advheadless -Task "只回复两个字：收到"
#   .\run-advtest.ps1 -Profile advtest -Web -Port 59988
#
param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Task,
  [switch]$Web,
  [int]$Port = 59988,
  [string]$DshHome = 'L:\超级工作间\.dsh-advtest',
  [string]$SourceHome = 'C:\Users\29493\.dsh'
)

$doc = Get-Content (Join-Path $SourceHome '.credentials.yaml') -Raw
foreach ($name in @('OPENCODE_API_KEY', 'ZHIPU_API_KEY', 'STRATA_API_KEY')) {
  $m = [regex]::Match($doc, "(?m)^\s+" + $name + ":\s*(\S+)\s*$")
  if ($m.Success) { Set-Item -Path ("env:" + $name) -Value $m.Groups[1].Value }
}

$env:DSH_HOME = $DshHome
Set-Location -LiteralPath 'L:\超级工作间'
if ($Web) {
  & dsh --profile $Profile --no-open --port $Port
} else {
  & dsh --profile $Profile $Task
}

