# Alertas por Telegram e e-mail

Além do e-mail crítico agrupado por fazenda (destinatários de `alert_recipients`), cada grupo pode cadastrar **canais de alerta** na aba **Alertas** do painel. Só os papéis **Admin** e **TI** veem a aba. Um perfil de TI restrito a algumas fazendas só vê e altera canais cujo filtro fica dentro do seu escopo. Os demais canais respondem como inexistentes.

## O que cada canal define

| Campo | Efeito |
| --- | --- |
| Tipo | `Telegram` (bot + chat) ou `E-mail` (lista de até 50 destinatários, pelo mesmo SMTP/SES do worker) |
| Fazendas | Vazio vale para todas as fazendas do grupo. Fazendas fora do escopo do usuário são recusadas |
| Tipos de ocorrência | Coletor sem contato, coleta desatualizada, ativo offline, divergência de inventário. Vazio vale para todos |
| Severidade mínima | `Só críticas` (padrão) ou `Críticas e avisos` |
| Avisar o encerramento | Envia também a mensagem de ocorrência encerrada, apenas para quem recebeu a abertura |
| Mensagens por minuto | Limite do canal, de 1 a 120. O excedente espera o minuto seguinte sem gastar tentativa |

As mensagens saem em pt-BR e trazem a fazenda, o ativo (ou o coletor), a severidade, o horário no fuso da fazenda e o link do painel (`MALHA_PUBLIC_ORIGIN`). Ocorrências da mesma fazenda, do mesmo canal e do mesmo evento saem juntas em uma mensagem, com até 20 itens. No Telegram o texto usa `parse_mode=HTML` e todo dado do cadastro é escapado (`&`, `<`, `>`, `"`).

## Como o worker entrega

1. **Roteamento.** A cada minuto, depois da avaliação das ocorrências, o worker cria uma entrega por ocorrência, canal e evento (`abertura` ou `encerramento`). A chave de idempotência `ocorrência:canal:evento` é única no banco, então reavaliações e várias réplicas do worker não duplicam mensagens. Só entram ocorrências abertas depois que o canal foi criado, reativado ou teve o filtro alterado, então o passado não é reenviado.
2. **Supressão.** Iguais ao e-mail crítico: ativos em janela de manutenção e ativos de fazenda com o coletor sem contato ficam como `Suprimida`. A ocorrência do coletor sai normalmente. Uma abertura que já foi encerrada antes do envio é `Descartada`.
3. **Retentativa.** Falhas temporárias (rede, HTTP 5xx) voltam após 30 s, 60 s, 120 s, 240 s… até 15 min, com no máximo 5 tentativas. HTTP 429 do Telegram respeita o `retry_after`. Erros permanentes (400, 401, 403 e 404, por exemplo chat inexistente ou bot bloqueado) marcam `Falhou` sem nova tentativa.
4. **Histórico.** A tabela **Histórico de entregas** mostra as últimas 100 entregas no escopo do usuário, com situação, tentativas, próxima tentativa e o último erro (sem token).

Toda criação, alteração, ativação, desativação e teste de canal entra na trilha de auditoria, sem o token e sem os endereços de e-mail.

## Criar o bot no Telegram

1. No Telegram, abra uma conversa com **@BotFather** e envie `/newbot`. Escolha o nome e um usuário terminado em `bot`.
2. O BotFather responde com o token, no formato `123456789:AA...`. Trate-o como senha.
3. Adicione o bot ao grupo ou canal que vai receber os alertas. Em canais, o bot precisa ser administrador com permissão de publicar.
4. Descubra o **chat id**:
   - **Grupo:** envie qualquer mensagem no grupo mencionando o bot e abra `https://api.telegram.org/bot<TOKEN>/getUpdates` no seu navegador. O campo `chat.id` é o valor, em geral negativo (`-100...` em supergrupos).
   - **Canal público:** use `@nome_do_canal`.
   - **Conversa direta:** envie `/start` ao bot e leia o `chat.id` em `getUpdates`.
5. Na aba **Alertas**, cadastre o canal do tipo Telegram com o token e o chat id e clique em **Enviar teste**.

Se o grupo virar supergrupo, o chat id muda. O Telegram responde 400 e a entrega aparece como `Falhou`. Edite o canal com o novo id.

## Sigilo do token

- O token é cifrado em repouso com AES-256-GCM, a mesma cifra das senhas LDAP e dos tokens de monitoramento (`sealSecret` com chave derivada de `MALHA_AUTH_SECRET`, propósito `notification-token`). Sem `MALHA_AUTH_SECRET` com pelo menos 32 bytes, o piloto recusa cadastrar tokens.
- A API devolve só a dica mascarada (`••••abcd`). Para trocar, informe um token novo. Em branco, o atual é mantido.
- O destino é fixo em `https://api.telegram.org`, sem URL vinda do cadastro e sem seguir redirecionamentos. Erros gravados no histórico e nos logs passam por uma limpeza que remove qualquer texto com formato de token.
- Os logs do worker registram apenas o tipo do canal e o nome do erro, sem texto da mensagem, sem destinatários e sem token.
- Trocar `MALHA_AUTH_SECRET` torna os tokens ilegíveis. A entrega aparece como `Falhou` com a orientação de cadastrar o token de novo.

## Configuração

| Variável | Uso |
| --- | --- |
| `MALHA_AUTH_SECRET` | Chave da cifra dos tokens (já usada pela sessão) |
| `MALHA_PUBLIC_ORIGIN` | Link do painel nas mensagens. Só `https://` ou `http://` sem credenciais. Fora disso, a mensagem sai sem link |
| `MALHA_SMTP_URL`, `MALHA_ALERT_FROM` | Transporte dos canais de e-mail (SES pelo endpoint SMTP). Sem eles, o botão de teste de e-mail responde 503 |

O worker precisa de saída HTTPS para `api.telegram.org:443`. Se a VPC restringe saída, libere esse destino no NAT ou no proxy.

## Banco

A migração `012_alertas_push.sql` cria `notification_channels` e `notification_deliveries`, as duas com RLS (`org_scope` sobre `malha.org_id`), e `runtime-grants.sql` concede `SELECT, INSERT, UPDATE` ao `malha_runtime`. Não há `DELETE`: canais são desativados e o histórico fica.
