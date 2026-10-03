<#
  桌宠的开关控制器
    pwsh -File scripts/pet-ctl.ps1 start     启动
    pwsh -File scripts/pet-ctl.ps1 stop      关闭
    pwsh -File scripts/pet-ctl.ps1 status    看看在不在跑

  平时不用直接敲这个 —— 双击项目根目录的「启动桌宠.cmd」「关闭桌宠.cmd」就行，
  那两个只是把参数传进来。

  ────────────────────────────────────────────────────────────────────
  为什么「关闭」不直接 Stop-Process
  ────────────────────────────────────────────────────────────────────
  PowerShell 的 Stop-Process 是**强杀**（TerminateProcess），
  进程没有机会跑自己的退出流程 —— 而桌宠退出时要做两件正事：
    · 把桌宠自己拉起来的语音服务（GPT-SoVITS，占着约 2.9G 显存）关掉
    · 落盘还没整理完的对话记忆
  强杀的话语音服务会变成孤儿进程一直占着显存，用户只会觉得「关了怎么显存没降」。

  所以走 taskkill **不带 /F** —— 它给窗口发 WM_CLOSE，
  桌宠收到后正常走 window-all-closed → will-quit 那一套。
  等一会儿还不退，才升级成强杀（并且这时候要自己补刀收拾语音服务）。
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'status',
  # 关闭时不碰语音服务（你自己单独起着调试的时候用）
  [switch]$KeepVoice,
  # 启动时把日志直接打到当前窗口，方便看报错
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot          # desktop-pet/
$UserData = Join-Path $Root '.userdata'
$PidFile = Join-Path $UserData 'pet.pid'
$LogFile = Join-Path $UserData 'pet.log'

function Get-PetProcess {
  <#
    先信 pet.pid；文件不在或者那个 pid 已经死了，就退回按命令行捞。
    为什么要有退路：老版本没有 pid 文件，或者用户从别的终端起的、pid 文件被删了。
  #>
  if (Test-Path $PidFile) {
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
    $pidNum = 0
    if ([int]::TryParse(($raw -replace '\s', ''), [ref]$pidNum)) {
      $p = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -like 'electron*') { return $p }
    }
  }
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*" } |
    ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
    Select-Object -First 1
}

function Get-VoiceProcesses {
  Get-CimInstance Win32_Process -Filter "Name like '%python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*api_v2*' }
}

# ---------------------------------------------------------------- status

function Get-TtsBackend {
  <#
    从 config.json 读当前语音后端。
    为什么状态显示要看它：本地那个 GPT-SoVITS 服务只在 backend=gptsovits 时才会被拉起来，
    换成 minimax（云端）之后它永远不会启动 —— 那时候还提示「首次说话时她会自己拉起来」
    就是在骗人。踩过：换成云端后状态页还在这么说。
  #>
  try {
    $cfg = Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$cfg.tts.backend
  } catch {
    return ''
  }
}

function Show-Status {
  $backend = Get-TtsBackend
  $cloud = $backend -and $backend -ne 'gptsovits'
  $p = Get-PetProcess
  if ($p) {
    "桌宠：在跑（pid $($p.Id)）"
    $v = Get-VoiceProcesses
    if ($v) { "语音服务：在跑（pid $($v.ProcessId -join ', ')）" }
    elseif ($cloud) { "语音服务：不需要（backend=$backend，走云端，不占显存）" }
    else { "语音服务：没在跑（首次说话时她会自己拉起来，约 10 秒）" }
  } else {
    "桌宠：没在跑"
    # 桌宠不在但语音服务还在 —— 这是孤儿，值得单独说一句
    $v = Get-VoiceProcesses
    if ($v) { "语音服务：还在跑（pid $($v.ProcessId -join ', ')）—— 桌宠已经退了但没收拾干净，跑一次「关闭桌宠」能清掉" }
  }
  if ($backend) { "语音后端：$backend" }
}

# ---------------------------------------------------------------- start

function Start-Pet {
  $p = Get-PetProcess
  if ($p) {
    # 桌宠有单实例锁：再起一个它会把已有窗口唤到前面然后自己退出。
    # 与其在外面想办法把窗口弄到前台（很难做对），不如就让这个新实例去干这件事。
    "桌宠已经在跑了（pid $($p.Id)），把它唤到前面…"
    Start-Detached -Quiet
    return
  }

  $exe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) {
    "❌ 找不到 electron：$exe"
    "   先在这个目录跑一次 npm install"
    exit 1
  }

  if ($Foreground) {
    "前台启动（Ctrl+C 结束）…"
    & $exe $Root
    return
  }

  Start-Detached
  Start-Sleep -Milliseconds 1200
  $p = Get-PetProcess
  if ($p) { "✅ 桌宠起来了（pid $($p.Id)）。日志：$LogFile" }
  else { "⚠️ 没看到进程。看看日志：$LogFile" }
}

function Start-Detached {
  param([switch]$Quiet)

  New-Item -ItemType Directory -Force -Path $UserData | Out-Null
  $exe = Join-Path $Root 'node_modules\electron\dist\electron.exe'

  # ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成「就是个 node」：
  #    require('electron') 返回的是二进制路径字符串而不是 API 对象，
  #    main.js 第 41 行 app.setPath(...) 立刻 TypeError，窗口根本不会出现。
  #    症状很误导 —— 报错指向 main.js 的 app，看起来像代码写错了。
  #    任何以 Electron 为宿主的环境（VS Code 终端、某些自动化工具）都可能带上它。
  if ($env:ELECTRON_RUN_AS_NODE) { Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }

  # 用 Start-Process 而不是 `& $exe`：
  # 后者是子进程，关掉这个窗口会把它一起带走 —— 用户双击启动、窗口一关桌宠就没了。
  # Start-Process 起的是独立进程，和这个脚本没有父子牵连。
  #
  # 输出重定向到文件：双击启动看不到控制台，出问题得有地方查。
  $args = @{ FilePath = $exe; WorkingDirectory = $Root; WindowStyle = 'Hidden' }
  if (-not $Quiet) {
    $args.RedirectStandardOutput = $LogFile
    $args.RedirectStandardError = (Join-Path $UserData 'pet.err.log')
  }
  $args.ArgumentList = @($Root)
  Start-Process @args | Out-Null
}

# ---------------------------------------------------------------- stop

function Stop-Pet {
  $p = Get-PetProcess
  if (-not $p) {
    "桌宠没在跑。"
    # 没在跑也要清一次 pid 文件：上一轮要是被强杀的，文件会留下来，
    # 而那个 pid 迟早会被 Windows 分配给别的进程 —— 下次「关闭」就可能认错人。
    if (Test-Path $PidFile) {
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
      "  （顺手清掉了一个过期的 pet.pid）"
    }
    if (-not $KeepVoice) { Stop-Voice }
    return
  }

  $pidNum = $p.Id
  "正在关闭桌宠（pid $pidNum）…"

  # 不带 /F：发 WM_CLOSE，让它走正常退出流程（收语音服务 + 落盘记忆）
  & taskkill /PID $pidNum 2>&1 | Out-Null

  $waited = 0
  while ($waited -lt 10000) {
    Start-Sleep -Milliseconds 400
    $waited += 400
    if (-not (Get-Process -Id $pidNum -ErrorAction SilentlyContinue)) { break }
  }

  if (Get-Process -Id $pidNum -ErrorAction SilentlyContinue) {
    "  正常关闭超时（10 秒），强杀。"
    "  注意：强杀时她来不及自己收语音服务，下面我来补刀。"
    & taskkill /PID $pidNum /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
  } else {
    "  已正常退出（$([math]::Round($waited / 1000, 1)) 秒）。"
  }

  if (-not $KeepVoice) { Stop-Voice }

  # pid 文件要是留下了（强杀就会），清掉，免得下次认错人
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
  "✅ 桌宠已关闭。"
}

function Stop-Voice {
  $v = @(Get-VoiceProcesses)
  if (-not $v.Count) { return }

  # 语音服务是桌宠的子进程，正常退出时它已经自己收了 —— 走到这儿说明是孤儿。
  "  收拾残留的语音服务（pid $($v.ProcessId -join ', ')）…"
  foreach ($proc in $v) { & taskkill /PID $proc.ProcessId /T /F 2>&1 | Out-Null }
  Start-Sleep -Milliseconds 800

  $left = @(Get-VoiceProcesses)
  if ($left.Count) { "  ⚠️ 还有 $($left.Count) 个没杀掉，去任务管理器看看 python" }
  else { "  语音服务已清干净。" }
}

# ---------------------------------------------------------------- 入口

switch ($Action) {
  'start' { Start-Pet }
  'stop' { Stop-Pet }
  'status' { Show-Status }
}
