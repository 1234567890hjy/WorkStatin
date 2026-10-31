#!/usr/bin/env bash
# 手工构建 APK：aapt2 → javac → d8 → zipalign → apksigner
#
# 为什么不用 Gradle：Gradle + AGP 要下载数百 MB 依赖，
# 在本环境（无 Android Studio、无 Gradle）不确定性大。
# 手工链路每步可控，且能在真实模拟器上直接验证。
#
# 用法：
#   bash apps/android/build.sh          # debug 签名，可直接侧载
#
# 依赖（路径可用环境变量覆盖）：
#   ANDROID_SDK_ROOT  默认 E:/work/soft/android-sdk-windows
#   JAVA_HOME         默认 D:/Java/jdk-17（AGP 需要 17+，本脚本用 17 编译）

set -euo pipefail

# 跨平台：Windows 上工具带 .exe/.bat 后缀，Linux/macOS 上不带。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXE=".exe"; BAT=".bat"; SEP=";" ;;
  *)                    EXE="";     BAT="";     SEP=":" ;;
esac

SDK="${ANDROID_SDK_ROOT:-E:/work/soft/android-sdk-windows}"
JDK="${JAVA_HOME:-D:/Java/jdk-17}"
BUILD_TOOLS="$SDK/build-tools/29.0.3"
PLATFORM="$SDK/platforms/android-28/android.jar"

AAPT2="$BUILD_TOOLS/aapt2$EXE"
D8="$BUILD_TOOLS/d8$BAT"
ZIPALIGN="$BUILD_TOOLS/zipalign$EXE"
APKSIGNER="$BUILD_TOOLS/apksigner$BAT"
JAVAC="$JDK/bin/javac$EXE"
KEYTOOL="$JDK/bin/keytool$EXE"
JAR="$JDK/bin/jar$EXE"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/app/src/main"
OUT="$HERE/build"
DIST="$HERE/dist"

PKG="me.workstation.notify"
MIN_SDK=26
TARGET_SDK=28

# ---- 前置检查 ----
for f in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER"; do
  [ -f "$f" ] || { echo "缺少构建工具：$f"; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "缺少 android.jar：$PLATFORM"; exit 1; }
[ -x "$JAVAC" ] || { echo "缺少 JDK：$JDK"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex" "$DIST"

echo "==> 1/6 编译资源 (aapt2 compile)"
"$AAPT2" compile \
  --dir "$APP/res" \
  -o "$OUT/res/compiled.zip"

echo "==> 2/6 链接资源与清单 (aapt2 link)"
"$AAPT2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --java "$OUT/gen" \
  "$OUT/res/compiled.zip"

echo "==> 3/6 编译 Java (javac)"
mkdir -p "$OUT/gen"
# 仓库路径含空格（"Workstatin Me"），@argfile 与空格路径会被拆开。
# 解法：cd 到源码根，用不含空格的相对路径。
SRC_LIST="$(cd "$APP/java" && find . -name '*.java' | sed 's|^\./||')"
GEN_LIST=""
if [ -d "$OUT/gen" ] && [ -n "$(find "$OUT/gen" -name '*.java' 2>/dev/null)" ]; then
  GEN_LIST="$(cd "$OUT/gen" && find . -name '*.java' | sed 's|^\./||')"
fi

(
  cd "$APP/java"
  "$JAVAC" \
    -encoding UTF-8 \
    -source 8 -target 8 \
    -bootclasspath "$PLATFORM" \
    -classpath "$PLATFORM" \
    -d "$OUT/classes" \
    $SRC_LIST
) 2>&1 | grep -viE "^注|warning|deprecat" || true

# R.java（若 aapt2 生成）单独编，路径在 gen 下
if [ -n "$GEN_LIST" ]; then
  (
    cd "$OUT/gen"
    "$JAVAC" \
      -encoding UTF-8 \
      -source 8 -target 8 \
      -bootclasspath "$PLATFORM" \
      -classpath "$PLATFORM$SEP$OUT/classes" \
      -d "$OUT/classes" \
      $GEN_LIST
  ) 2>&1 | grep -viE "^注|warning|deprecat" || true
fi

echo "==> 4/6 转 dex (d8)"
# d8 的 --output 与输入路径同样怕空格：先 cd 到 classes 根，
# 用相对路径喂给它，输出目录用绝对路径（d8 允许输出路径含空格）。
(
  cd "$OUT/classes"
  find . -name '*.class' | sed 's|^\./||' > "$OUT/classes.txt"
  if [ ! -s "$OUT/classes.txt" ]; then echo "没有编译出 class"; exit 1; fi
  "$D8" \
    --lib "$PLATFORM" \
    --min-api "$MIN_SDK" \
    --output "$OUT/dex" \
    $(cat "$OUT/classes.txt" | tr '\n' ' ') 2>&1 | tail -5
)

echo "==> 5/6 打包 (add dex into apk)"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && "$JAR" uf "$OUT/unsigned.apk" classes.dex 2>/dev/null) \
  || (cd "$OUT/dex" && zip -q "$OUT/unsigned.apk" classes.dex)

echo "==> 6/6 对齐与签名"
"$ZIPALIGN" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -v \
    -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" > /dev/null 2>&1
fi

"$APKSIGNER" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$DIST/workstation-notify.apk" \
  "$OUT/aligned.apk"

echo
echo "✅ 构建完成：$DIST/workstation-notify.apk"
ls -la "$DIST/workstation-notify.apk"
