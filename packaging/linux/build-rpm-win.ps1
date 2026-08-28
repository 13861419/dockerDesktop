# ============================================================
#  Docker Manager - Windows 上构建 .rpm 包（替代 build-rpm.sh）
#  原因：本机 bash 为 WSL bash 且未接入 Docker Desktop WSL 集成。
#  说明：构建环境为 AlmaLinux 9（CentOS 7 glibc 2.17 无法运行 Node 22）。
#  用法: powershell -File build-rpm-win.ps1 [-Arch x86_64|aarch64]
#  ⚠ 容器内打包逻辑在 .rpm-inner.sh，与 build-rpm.sh 保持同步
# ============================================================
param([string]$Arch = "x86_64")
$ErrorActionPreference = 'Stop'

# rpm 架构名 → docker 平台名（x86_64→amd64，aarch64→arm64）
$platform = if ($Arch -eq 'aarch64') { 'linux/arm64' } else { 'linux/amd64' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$image = "dm-build-rpm-$Arch"
$releaseDir = Join-Path $root 'dist-release'
$inner = Join-Path $PSScriptRoot '.rpm-inner.sh'

# 1. 内部脚本注入版本号/架构；换行符强制 LF（CRLF 会破坏 bash heredoc）
$innerText = ((Get-Content $inner -Raw -Encoding UTF8) -replace '__VERSION__', $version -replace '__ARCH__', $Arch) -replace "`r`n", "`n"
$tmpInner = Join-Path $env:TEMP ".rpm-inner-$Arch.sh"
[System.IO.File]::WriteAllText($tmpInner, $innerText, [System.Text.UTF8Encoding]::new($false))

# 2. 构建镜像（容器内完成 npm install + 前后端构建）
Write-Host "[BUILD-RPM] 构建 Docker 镜像 (AlmaLinux 9, $Arch) ..."
docker buildx build --platform $platform --load `
  -f (Join-Path $PSScriptRoot 'Dockerfile.el9') -t $image $root
if ($LASTEXITCODE -ne 0) { Write-Error '镜像构建失败'; exit 1 }

# 3. 容器内打包（dist-release 挂到 /output，内部脚本挂到 /inner.sh）
$tmpSize = (Get-Item $tmpInner).Length
if ($tmpSize -lt 1000) { Write-Error "内部脚本写入异常（$tmpSize 字节）"; exit 1 }
Write-Host "[BUILD-RPM] 内部脚本 $($tmpSize) 字节，在容器内生成 .rpm 包 ..."
docker run --rm --platform $platform `
  -v "${releaseDir}:/output" `
  -v "${tmpInner}:/inner.sh:ro" `
  $image bash /inner.sh
if ($LASTEXITCODE -ne 0) { Write-Error '打包失败'; exit 1 }
if (-not (Get-ChildItem (Join-Path $releaseDir 'docker-manager-*.rpm') -ErrorAction SilentlyContinue)) {
  Write-Error '未找到 .rpm 产物'; exit 1
}
Write-Host "[BUILD-RPM] .rpm 构建完成"
