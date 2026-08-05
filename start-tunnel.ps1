# Keeps cloudflared running — restarts it if it dies
while ($true) {
    $proc = Start-Process "C:\Program Files (x86)\cloudflared\cloudflared.exe" `
        -ArgumentList "--config `"C:\Users\sange\.cloudflared\config.yml`" tunnel run trading-dashboard" `
        -PassThru -WindowStyle Hidden
    Write-Host "$(Get-Date) cloudflared started PID $($proc.Id)"
    $proc.WaitForExit()
    Write-Host "$(Get-Date) cloudflared exited — restarting in 5s..."
    Start-Sleep -Seconds 5
}
