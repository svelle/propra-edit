# Windows version of fetch-runtime.sh: downloads LanguageTool (Maven Central, checksums
# verified) and builds a trimmed Java runtime with jlink. Needs Maven and a JDK >= 21.
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Res = Join-Path $Root "src-tauri\resources"
$LtLib = Join-Path $Res "languagetool\lib"
$Jre = Join-Path $Res "jre"
$Modules = "java.base,java.compiler,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.scripting,java.sql,java.xml,jdk.crypto.ec,jdk.httpserver,jdk.localedata,jdk.unsupported,jdk.zipfs"

Write-Host "==> LanguageTool jars"
if (Test-Path $LtLib) { Remove-Item -Recurse -Force $LtLib }
& mvn -B -q -C -f (Join-Path $Root "scripts\languagetool\pom.xml") dependency:copy-dependencies "-DoutputDirectory=$LtLib" "-DincludeScope=runtime"
if ($LASTEXITCODE -ne 0) { throw "mvn failed" }

Write-Host "==> Java runtime (jlink)"
$Jlink = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME "bin\jlink.exe" } else { "jlink" }
if (Test-Path $Jre) { Remove-Item -Recurse -Force $Jre }
& $Jlink --add-modules $Modules --include-locales=de,en --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output $Jre
if ($LASTEXITCODE -ne 0) { throw "jlink failed" }
New-Item -ItemType File -Force (Join-Path $Jre ".gitkeep") | Out-Null
New-Item -ItemType File -Force (Join-Path $Res "languagetool\.gitkeep") | Out-Null
& (Join-Path $Jre "bin\java.exe") -version
Write-Host "Done."
