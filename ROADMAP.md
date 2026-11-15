# Roadmap

O que a comunidade e a manutenção querem construir a seguir. Nada aqui é promessa de data. Cada item vira uma issue com o rótulo correspondente; comente nela para ajudar ou dar prioridade.

## Agora

| Item | Por que |
| --- | --- |
| Importar o catálogo num servidor Zabbix 7.0 ao vivo | Os nomes já foram conferidos no código oficial do 7.0; falta o teste de importação em campo |
| Testar o login OIDC com Google Workspace, Okta e Keycloak reais | O fluxo tem testes automáticos, mas falta a validação com cada provedor |

## Depois

| Item | Por que | Depende de |
| --- | --- | --- |
| Homologação em campo | Validar console física, firmware, diretório do cliente e 24 h sem WAN | Hardware e um grupo piloto |
| Conectores MikroTik e FortiGate | Mesmo contrato de observações para outras redes | Inventário de modelos e permissões somente leitura |
| Starlink e link de failover | Saber se a fazenda caiu ou só trocou de link | Acesso à API da conta Starlink |
| Prontidão de safra | Checklists versionados por fazenda, com evidências e prazo | Responsável por fazenda |
| Mais fabricantes no catálogo de monitoramento | FortiGate, MikroTik, TP-Link e Aruba CX já entram; faltam Intelbras e outras linhas Aruba | Templates oficiais do Zabbix |
| Tradução da interface (inglês e espanhol) | Grupos agrícolas no Mercosul | Extração dos textos |

## Ideias em discussão

| Item | Por que |
| --- | --- |
| Servidor MCP somente leitura | Triagem assistida por IA respeitando o escopo de cada usuário |
| Entrada e saída de pessoas | Admissão e desligamento ligados a SAP/TOTVS e ao diretório |
| Autocura com aprovação | Reiniciar porta PoE ou forçar failover, com janela e retorno |

Tem outra ideia? Abra uma [discussão](https://github.com/targino-tech/malha/discussions/categories/ideas).
