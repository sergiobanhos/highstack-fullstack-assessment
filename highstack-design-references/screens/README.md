# HighStack player UI concepts

Mockups visuais unitários para orientar uma futura implementação. Cada PNG representa uma única tela ou um único estado; fluxos com modais são mostrados com apenas um modal aberto. As telas ainda não foram implementadas no frontend.

## Autenticação

- `auth-login.png` — entrar
- `auth-register.png` — criar conta, com mínimo de 12 caracteres na senha

## Jogo

- `game-betting-open.png` — rodada aguardando apostas
- `game-running.png` — rodada ativa com aposta em andamento
- `game-cashout-complete.png` — cashout confirmado em modal
- `game-crashed.png` — rodada encerrada por crash
- `game-reconnecting-cashout-unknown.png` — conexão interrompida e resultado do cashout ainda desconhecido

## Carteira e pagamentos simulados

- `wallet-overview.png` — carteira e histórico
- `wallet-top-up-modal.png` — modal de adicionar fundos de teste
- `wallet-top-up-success.png` — confirmação do top-up de teste
- `wallet-top-up-unknown.png` — top-up sem confirmação; orienta consultar o status antes de abrir outro pedido
- `wallet-payout-modal.png` — modal para solicitar payout
- `wallet-payout-processing.png` — payout em processamento
- `wallet-payout-complete.png` — payout concluído
- `wallet-payout-validation-error.png` — erro de validação do formulário de payout
- `wallet-payout-unknown.png` — payout sem confirmação; orienta consultar o status antes de abrir outro pedido

Top-up e payout aparecem como simulações locais. As imagens não afirmam que dinheiro real foi enviado ou recebido.

## Assets prontos para o frontend

- `../../client/public/assets/highstack-logo.png` — cópia do logo oficial fornecido nas referências
- `../../client/public/assets/highstack-background.png` — textura/fundo abstrato escuro com brilho verde, sem interface ou texto

O frontend ainda não referencia esses assets. Gráficos de rodada, valores, botões, modais e demais partes dinâmicas devem ser componentes de interface, não imagens rasterizadas.

## Direção visual

Grafite e verde escuro, brilho esmeralda contido e acentos turquesa, respeitando as referências de marca fornecidas. Ações de carteira abrem modais sobre a tela da carteira; estados de sucesso, processamento, validação e resultado desconhecido também têm uma imagem independente.
