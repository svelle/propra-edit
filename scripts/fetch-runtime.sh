#!/usr/bin/env bash
# Downloads LanguageTool (from Maven Central, checksums verified) and builds a trimmed Java
# runtime with jlink from the current JDK. Results go to src-tauri/resources/ (not committed).
# Needs: Maven, and a JDK >= 21 (JAVA_HOME or jlink on PATH).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RES="$ROOT/src-tauri/resources"
LT_LIB="$RES/languagetool/lib"
JRE="$RES/jre"
# Modules LanguageTool's server needs (jdeps on languagetool-server plus logging/locale extras).
MODULES=java.base,java.compiler,java.desktop,java.instrument,java.logging,java.management,java.naming,java.net.http,java.scripting,java.sql,java.xml,jdk.crypto.ec,jdk.httpserver,jdk.localedata,jdk.unsupported,jdk.zipfs

echo "==> LanguageTool jars"
rm -rf "$LT_LIB"
mvn -B -q -C -f "$ROOT/scripts/languagetool/pom.xml" dependency:copy-dependencies \
  -DoutputDirectory="$LT_LIB" -DincludeScope=runtime
echo "    $(ls "$LT_LIB" | wc -l | tr -d ' ') jars, $(du -sh "$LT_LIB" | cut -f1)"

echo "==> Java runtime (jlink)"
JLINK=jlink
[ -n "${JAVA_HOME:-}" ] && JLINK="$JAVA_HOME/bin/jlink"
rm -rf "$JRE"
"$JLINK" --add-modules "$MODULES" --include-locales=de,en \
  --strip-debug --no-man-pages --no-header-files --compress=zip-6 --output "$JRE"
touch "$JRE/.gitkeep" "$RES/languagetool/.gitkeep"
"$JRE/bin/java" -version 2>&1 | head -1
echo "    $(du -sh "$JRE" | cut -f1)"
echo "Done."
