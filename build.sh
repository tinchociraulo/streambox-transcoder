#!/usr/bin/env bash
# Este script corre en Render como Build Command
# Instala ffmpeg y las dependencias de Node

set -e

echo "=== Instalando ffmpeg ==="
apt-get update -qq && apt-get install -y -qq ffmpeg

echo "=== Versión de ffmpeg ==="
ffmpeg -version | head -1

echo "=== Instalando dependencias Node ==="
npm install

echo "=== Build completado ==="
