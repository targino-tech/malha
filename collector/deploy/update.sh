#!/usr/bin/env bash
# Atualiza o coletor a partir de uma release assinada, mantendo a versão anterior para retorno.
#
# Uso: sudo ./update.sh <diretório-da-release>
#   O diretório contém malha-collector-linux-<arch>, SHA256SUMS, manifest.json e os arquivos *.sigstore.json
#   baixados da release do GitHub (gh release download collector-vX.Y.Z).
#
# Atualize uma fazenda piloto primeiro. O spool SQLite é preservado entre versões.
set -euo pipefail

release_dir="${1:?Informe o diretório com os arquivos da release.}"
repository="${MALHA_RELEASE_REPOSITORY:-targino-tech/malha}"
binary="/usr/local/bin/malha-collector"
previous="$binary.previous"
service="malha-collector"
issuer="https://token.actions.githubusercontent.com"
identity_regexp="^https://github.com/${repository}/\.github/workflows/collector-release\.yml@refs/tags/collector-v[0-9]+\.[0-9]+\.[0-9]+$"

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Arquitetura não homologada: $(uname -m)" >&2; exit 1 ;;
esac
artifact="malha-collector-linux-$arch"

command -v cosign >/dev/null || { echo "Instale o cosign para verificar a assinatura." >&2; exit 1; }
cd "$release_dir"

echo "Verificando assinaturas da release..."
for file in manifest.json SHA256SUMS "$artifact"; do
  cosign verify-blob --bundle "$file.sigstore.json" --certificate-oidc-issuer "$issuer" \
    --certificate-identity-regexp "$identity_regexp" "$file" >/dev/null
done
grep " $artifact\$" SHA256SUMS | sha256sum --check --strict -

version="$(jq -r .version manifest.json)"
echo "Instalando a versão $version ($arch)."

if [[ -x "$binary" ]]; then
  cp --preserve=mode "$binary" "$previous"
fi
install -m 0755 "$artifact" "$binary.new"
mv -f "$binary.new" "$binary"

systemctl restart "$service"
sleep 30
if systemctl is-active --quiet "$service" && [[ "$("$binary" version)" == "$version" ]]; then
  echo "Coletor $version ativo. Confirme o heartbeat e a próxima coleta em Integrações."
  exit 0
fi

echo "O serviço não ficou ativo com a versão $version. Voltando para a versão anterior." >&2
if [[ -x "$previous" ]]; then
  mv -f "$previous" "$binary"
  systemctl restart "$service"
fi
journalctl -u "$service" --since "-5 min" --no-pager | tail -n 40 >&2
exit 1
