# ============================================================
#  Docker Manager - Windows 上构建 .deb 包（替代 build-deb.sh）
#  原因：本机 bash 为 WSL bash 且未接入 Docker Desktop WSL 集成，
#        故由 PowerShell 直接驱动 docker CLI，容器内逻辑不变。
#  用法: powershell -File build-deb-win.ps1 [-Arch amd64|arm64]
#  ⚠ 容器内打包逻辑在 .deb-inner.sh，与 build-deb.sh 保持同步
# ============================================================
param([string]$Arch = "amd64")
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$image = "dm-build-deb-$Arch"
$releaseDir = Join-Path $root 'dist-release'
$inner = Join-Path $PSScriptRoot '.deb-inner.sh'

# 1. 内部脚本注入版本号/架构；换行符强制 LF（CRLF 会让 bash heredoc 目标路径带 \r）
$innerText = ((Get-Content $inner -Raw -Encoding UTF8) -replace '__VERSION__', $version -replace '__ARCH__', $Arch) -replace "`r`n", "`n"
$tmpInner = Join-Path $env:TEMP ".deb-inner-$Arch.sh"
[System.IO.File]::WriteAllText($tmpInner, $innerText, [System.Text.UTF8Encoding]::new($false))

# 2. 构建镜像（容器内完成 npm install + 前后端构建）
Write-Host "[BUILD-DEB] 构建 Docker 镜像 (Ubuntu 24, $Arch) ..."
docker buildx build --platform "linux/$Arch" --load `
  -f (Join-Path $PSScriptRoot 'Dockerfile.ubuntu24') -t $image $root
if ($LASTEXITCODE -ne 0) { Write-Error '镜像构建失败'; exit 1 }

# 3. 容器内打包（dist-release 挂到 /output，内部脚本挂到 /inner.sh）
#    防呆：临时脚本必须完整落盘（曾出现 0 字节挂载导致空脚本静默通过）
$tmpSize = (Get-Item $tmpInner).Length
if ($tmpSize -lt 1000) { Write-Error "内部脚本写入异常（$tmpSize 字节）"; exit 1 }
Write-Host "[BUILD-DEB] 内部脚本 $($tmpSize) 字节，在容器内生成 .deb 包 ..."
docker run --rm --platform "linux/$Arch" `
  -v "${releaseDir}:/output" `
  -v "${tmpInner}:/inner.sh:ro" `
  $image bash /inner.sh
if ($LASTEXITCODE -ne 0) { Write-Error '打包失败'; exit 1 }
if (-not (Test-Path (Join-Path $releaseDir "docker-manager-$version-$Arch.deb"))) {
  Write-Error '未找到 .deb 产物'; exit 1
}

Write-Host "[BUILD-DEB] .deb 构建完成"
