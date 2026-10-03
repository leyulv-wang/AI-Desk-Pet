# 下载 DDSP-SVC 的 3 个预训练依赖
#
# 坑（都踩过，别再犯）：
#   ① curl 的输出**不能进 PowerShell 管道**，进度会被缓冲，看起来像卡死 → 一律重定向到日志文件
#   ② GitHub / HuggingFace 都**必须走代理**，直连超时（本机代理 127.0.0.1:7890）

$ErrorActionPreference = 'Continue'
$proxy  = "http://127.0.0.1:7890"
$root   = "D:\models\DDSP-SVC\pretrain"
$log    = "$root\download.log"
$tmp    = "$env:TEMP\ddsp_dl"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

"" | Set-Content $log
function W($m) { $m | Tee-Object -FilePath $log -Append }

$files = @(
  @{ name='ContentVec 编码器'; out="$root\contentvec\pytorch_model.bin"; min=100
     url='https://huggingface.co/lengyue233/content-vec-best/resolve/main/pytorch_model.bin' },
  @{ name='NSF-HiFiGAN 声码器'; out="$tmp\pc_nsf.zip"; min=20
     url='https://github.com/openvpi/vocoders/releases/download/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.zip' },
  @{ name='RMVPE 音高'; out="$tmp\rmvpe.zip"; min=20
     url='https://github.com/yxlllc/RMVPE/releases/download/230917/rmvpe.zip' }
)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($f in $files) {
  New-Item -ItemType Directory -Force -Path (Split-Path $f.out -Parent) | Out-Null
  if ((Test-Path $f.out) -and ((Get-Item $f.out).Length / 1MB -gt $f.min)) {
    W "[跳过] $($f.name) 已存在 $([math]::Round((Get-Item $f.out).Length/1MB,1)) MB"
    continue
  }
  if ((Test-Path $f.out) -and (Get-Item $f.out).Length -eq 0) { Remove-Item $f.out -Force }

  W ""
  W "[$([math]::Round($sw.Elapsed.TotalMinutes,1))min] 下载 $($f.name)"
  $try = 0
  while ($try -lt 6) {
    $try++
    & curl.exe -L --proxy $proxy --retry 5 --retry-delay 3 --retry-all-errors `
        --connect-timeout 30 --max-time 3600 --no-progress-meter `
        -o $f.out $f.url 2>> $log
    $mb = if (Test-Path $f.out) { [math]::Round((Get-Item $f.out).Length / 1MB, 1) } else { 0 }
    W "  第 $try 次：退出码=$LASTEXITCODE 已下 $mb MB"
    if ($mb -gt $f.min) { break }
    Start-Sleep -Seconds 4
  }
  W "  → $($f.name): $mb MB"
}

# ---- 解压 ----
W ""
W "=== 解压 ==="
$nz = "$tmp\pc_nsf.zip"
if ((Test-Path $nz) -and (Get-Item $nz).Length -gt 10MB) {
  Remove-Item "$root\nsf_hifigan\*" -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $nz -DestinationPath "$tmp\nsf" -Force
  # 压缩包里可能套一层目录，把里面的文件摊平到 nsf_hifigan
  Get-ChildItem "$tmp\nsf" -Recurse -File | ForEach-Object {
    Copy-Item $_.FullName "$root\nsf_hifigan\$($_.Name)" -Force
  }
  Get-ChildItem "$root\nsf_hifigan" | ForEach-Object { W "  nsf_hifigan/$($_.Name)" }
} else { W "  ❌ nsf zip 没下下来" }

$rz = "$tmp\rmvpe.zip"
if ((Test-Path $rz) -and (Get-Item $rz).Length -gt 10MB) {
  Expand-Archive -Path $rz -DestinationPath "$tmp\rmv" -Force
  Get-ChildItem "$tmp\rmv" -Recurse -File | ForEach-Object {
    # rmvpe.zip 里通常有个 rmvpe 目录，取 model.pt
    if ($_.Name -eq 'model.pt' -or $_.Name -eq 'rmvpe.pt') {
      Copy-Item $_.FullName "$root\rmvpe\$($_.Name)" -Force
    }
  }
  Get-ChildItem "$root\rmvpe" | ForEach-Object { W "  rmvpe/$($_.Name)" }
} else { W "  ❌ rmvpe zip 没下下来" }

W ""
W "=== 最终 ==="
Get-ChildItem $root -Recurse -File | Where-Object { $_.Name -ne 'download.log' } |
  ForEach-Object { W ("  {0,9:N1} MB  {1}" -f ($_.Length/1MB), $_.FullName.Replace($root,'')) }
W "总耗时 $([math]::Round($sw.Elapsed.TotalMinutes,1)) 分钟"
