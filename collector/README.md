# Coletor Malha

Coletor Go 1.27.4 para a API de Integrações do UniFi Network. Consulta sites e dispositivos adotados por `GET`, valida toda a paginação antes de aceitar a captura e guarda lotes em SQLite durante interrupções. O coletor inicia todas as conexões e assina as requisições ao Malha com sua chave Ed25519.

## Configuração

| Variável | Valor |
| --- | --- |
| `MALHA_URL` | Origem do Malha, por exemplo `https://ingest.malha.exemplo`. `http://127.0.0.1:3000` serve para teste local. |
| `MALHA_DATA_DIR` | Diretório dedicado à identidade e fila do coletor. Em Linux, use permissões `0700`. |
| `MALHA_ENROLL_CODE_FILE` | Caminho do arquivo de ativação de uso único. Também pode usar `MALHA_ENROLL_CODE`. |
| `UNIFI_BASE_URL` | URL HTTPS completa da API local, incluindo `/integration/v1`. Exemplo `https://console.exemplo/proxy/network/integration/v1`. Confirme o caminho na documentação da sua instalação. |
| `UNIFI_API_KEY_FILE` | Caminho do arquivo com a chave local UniFi. Também pode usar `UNIFI_API_KEY`. |
| `UNIFI_CA_FILE` | Arquivo PEM opcional com a CA da instalação. O certificado do UniFi deve corresponder ao host usado na URL. |
| `UNIFI_SITE_ID` | UUID do site vinculado à fazenda. |

```sh
go build -trimpath -o malha-collector .
./malha-collector sites
./malha-collector enroll
./malha-collector run
```

`sites` requer a URL e a credencial UniFi. Use o UUID retornado no `UNIFI_SITE_ID`. `enroll` requer a origem Malha e o código criado para a fazenda. Remova o código após a ativação. `run` usa a identidade persistida e envia heartbeat a cada minuto e inventário aproximadamente a cada cinco minutos. Para substituir um coletor, revogue a chave antiga e ative a nova instalação em um diretório distinto.

O serviço de exemplo em `deploy/malha-collector.service` usa a conta dedicada `malha-collector`, o binário em `/usr/local/bin/` e `/etc/malha/collector.env`. Crie a conta e proteja os arquivos de segredo para acesso exclusivo ao serviço. Faça a ativação com a mesma conta e diretório do serviço. O diretório guarda chave privada e dados de rede. Restrinja acesso e use volume cifrado conforme a política do cliente.

Cada captura é gravada em uma transação antes de qualquer envio. A fila prioriza capturas recentes e libera lotes somente após receber o recibo correspondente. A configuração inicial retém até 72 horas e 256 MiB de payloads pendentes, com sobrecarga do banco à parte. Dimensione e acompanhe o disco em campo. Se uma captura expirar ou for descartada na ingestão, o coletor registra o evento e sinaliza degradação no próximo heartbeat aceito.

## Verificação

```sh
go test ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o malha-collector .
```

Os testes usam um servidor UniFi simulado com TLS. A implantação exige confirmar a versão do firmware, o acesso à API local e a disponibilidade de credenciais com privilégio de leitura no equipamento do piloto. [Referência oficial UniFi](https://developer.ui.com/network/v10.6.102/getadopteddeviceoverviewpage)
