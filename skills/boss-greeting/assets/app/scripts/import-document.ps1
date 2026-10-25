param(
    [Parameter(Mandatory=$true)][string]$InputPath,
    [ValidateRange(1,40)][int]$MaxPages = 40,
    [ValidateRange(1,120000)][int]$MaxCharacters = 120000
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$failureCode = 'read_failed'

function Emit-Json($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
    [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
    [Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
    [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
    $asTaskOperation = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
    } | Select-Object -First 1
    if (-not $asTaskOperation -or -not $asTaskAction) { throw 'WinRT async bridge missing' }
    function Await-Operation($Operation, [Type]$ResultType) {
        $task = $asTaskOperation.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
        $task.GetAwaiter().GetResult()
    }
    function Await-Action($Operation) {
        $task = $asTaskAction.Invoke($null,@($Operation))
        $task.GetAwaiter().GetResult() | Out-Null
    }

    $failureCode = 'ocr_unavailable'
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
        foreach ($tag in @('zh-Hans','zh-Hans-CN','en-US')) {
            $language = New-Object Windows.Globalization.Language $tag
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            if ($engine) { break }
        }
    }
    if (-not $engine) { throw 'No OCR language available' }
    $failureCode = 'read_failed'
    $sourcePath = [IO.Path]::GetFullPath($InputPath)
    $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($sourcePath)) ([Windows.Storage.StorageFile])
    $warnings = New-Object 'Collections.Generic.List[string]'
    $warnings.Add('OCR文字可能有识别误差，请核对后再加入个人资料。')
    $parts = New-Object 'Collections.Generic.List[string]'
    $characterCount = 0
    $processedPages = 0
    $extension = [IO.Path]::GetExtension($sourcePath).ToLowerInvariant()

    function Read-BitmapText($Stream) {
        $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($Stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
        if ($decoder.PixelWidth -gt $maxDimension -or $decoder.PixelHeight -gt $maxDimension -or ([double]$decoder.PixelWidth * $decoder.PixelHeight) -gt 40000000) {
            $script:failureCode = 'image_too_large'
            throw 'Image dimensions exceed OCR limit'
        }
        $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $converted = $null
        try {
            $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
            $recognized = Await-Operation ($engine.RecognizeAsync($converted)) ([Windows.Media.Ocr.OcrResult])
            $lines = @($recognized.Lines | ForEach-Object { $_.Text })
            return ($lines -join "`n")
        } finally {
            if ($converted) { $converted.Dispose() }
            if ($bitmap) { $bitmap.Dispose() }
        }
    }

    Emit-Json @{event='progress';progress=5}
    if ($extension -eq '.pdf') {
        $document = Await-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
        $totalPages = [int]$document.PageCount
        $pageLimit = [Math]::Min($totalPages,$MaxPages)
        if ($totalPages -gt $MaxPages) { $warnings.Add(('文件共{0}页，本次只识别前{1}页。' -f $totalPages,$MaxPages)) }
        for ($index=0; $index -lt $pageLimit; $index++) {
            if ($characterCount -ge $MaxCharacters) { break }
            $page = $document.GetPage([uint32]$index)
            $memory = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            try {
                $render = New-Object Windows.Data.Pdf.PdfPageRenderOptions
                $scale = 2600.0 / [Math]::Max($page.Size.Width,$page.Size.Height)
                $render.DestinationWidth = [uint32][Math]::Max(1,[Math]::Round($page.Size.Width*$scale))
                $render.DestinationHeight = [uint32][Math]::Max(1,[Math]::Round($page.Size.Height*$scale))
                Await-Action ($page.RenderToStreamAsync($memory,$render))
                $memory.Seek(0)
                $pageText = Read-BitmapText $memory
                $processedPages++
                $prefix = if ($parts.Count -gt 0) { "`n`n" } else { '' }
                $candidate = $prefix + ('【第{0}页】' -f ($index+1)) + "`n" + $pageText
                $remaining = $MaxCharacters - $characterCount
                if ($candidate.Length -gt $remaining) { $candidate=$candidate.Substring(0,$remaining); $warnings.Add(('识别文字超过{0}字符，已截断；请分批导入或核对原文件。' -f $MaxCharacters)) }
                $parts.Add($candidate)
                $characterCount += $candidate.Length
            } finally { $memory.Dispose(); $page.Dispose() }
            Emit-Json @{event='progress';progress=[Math]::Min(95,[int](5+90*($index+1)/[Math]::Max(1,$pageLimit)))}
        }
        if ($processedPages -lt $pageLimit) { $warnings.Add(('已达到{0}字符上限，后续页面未识别。' -f $MaxCharacters)) }
        $method = 'windows-ocr-pdf'
    } elseif ($extension -in @('.png','.jpg','.jpeg','.bmp')) {
        $stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try { $text = Read-BitmapText $stream } finally { $stream.Dispose() }
        if ($text.Length -gt $MaxCharacters) { $text=$text.Substring(0,$MaxCharacters);$warnings.Add(('识别文字超过{0}字符，已截断。' -f $MaxCharacters)) }
        $parts.Add($text)
        $processedPages=1
        $method='windows-ocr-image'
    } else { $failureCode='unsupported_type'; throw 'Unsupported file type' }
    $text = ($parts -join '').Trim()
    if (-not $text -or $text -match '^(?:【第\d+页】\s*)+$') { $failureCode='no_text'; throw 'No text found' }
    Emit-Json @{event='result';result=@{text=$text;characters=$text.Length;pageCount=$processedPages;method=$method;warnings=@($warnings)}}
    exit 0
} catch {
    Emit-Json @{event='error';code=$failureCode}
    exit 1
}
