# clone_repo.ps1
# Clones the photonbot repository into the workspace
Write-Output "Cloning photonbot repository..."
git clone https://github.com/rektmuppets/photonbot-live.git trading-bot
if ($?) {
    Write-Output "Repository cloned successfully to trading-bot/"
} else {
    Write-Output "Error: Failed to clone repository"
    exit 1
}