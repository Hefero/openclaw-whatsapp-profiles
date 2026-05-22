$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

Write-Host "Starting whatsapp-chatbot..." -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"
Write-Host ""

cmd /c npm run warmup
$warmupCode = $LASTEXITCODE

Write-Host ""
Write-Host "Status:" -ForegroundColor Cyan
cmd /c npm run warmup:status
$statusCode = $LASTEXITCODE

Write-Host ""
if ($warmupCode -eq 0 -and $statusCode -eq 0) {
  Write-Host "Done. You can keep this window open or close it; services run in the background." -ForegroundColor Green
} else {
  Write-Host "Something failed. Check the output above and logs under data\runtime." -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to close"
