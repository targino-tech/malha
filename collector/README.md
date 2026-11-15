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

## Dados de rede e limitação conhecida

Desde o lote versão 2, o coletor também lê, só com `GET`, as portas de cada dispositivo (estado, conector, velocidade e estado PoE), o dispositivo a montante (`uplink.deviceId`), as taxas TX/RX do uplink (`statistics/latest`) e as redes/VLANs do site (`/networks`).

**Limitação conhecida:** a API de Integrações do UniFi não expõe **contadores por porta** (bytes, pacotes, erros e descartes), **VLAN por porta** (nativa e marcadas), **potência PoE por porta** nem **vizinhos LLDP ou a porta do uplink**. Por isso, com o UniFi:

- o tráfego medido em produção é a taxa de uplink de cada dispositivo, não o tráfego de cada porta;
- toda ligação vinda do UniFi é de nível **dispositivo**; o Malha só desenha ligação porta a porta quando a evidência identifica as duas pontas, o que hoje só acontece nos dados fictícios do demo;
- a ingestão já aceita esses campos como opcionais e reservados, para fontes que os tenham, mas este coletor não os envia.

Essa leitura foi feita sem uma controladora real e sem documentação oficial completa desses endpoints. Confirme os campos no console do piloto antes de contar com eles. Detalhes em [`docs/rede.md`](../docs/rede.md).

## Verificação

```sh
go test ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o malha-collector .
```

Os testes usam um servidor UniFi simulado com TLS. A implantação exige confirmar a versão do firmware, o acesso à API local e a disponibilidade de credenciais com privilégio de leitura no equipamento do piloto. [Referência oficial UniFi](https://developer.ui.com/network/v10.6.102/getadopteddeviceoverviewpage)
