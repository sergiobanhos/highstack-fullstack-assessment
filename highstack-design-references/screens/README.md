# HighStack player UI concepts

Conceitos visuais gerados a partir das referências HighStack existentes. São propostas de design para revisão; não foram implementadas no frontend.

| Arquivo | Tela e estados cobertos |
| --- | --- |
| `auth-login-register.png` | Entrar e criar conta |
| `gameplay-states.png` | Aposta aberta, rodada em andamento, cashout confirmado e crash com aposta perdida |
| `game-reconnecting-unknown-cashout.png` | Estado congelado durante reconexão e cashout com resultado desconhecido |
| `wallet-top-up.png` | Carteira, modal de add funds e confirmação de crédito de teste |
| `payout-flow.png` | Modais de solicitação, processamento e conclusão do payout simulado |

Preferência para a próxima implementação visual: ações de add funds e payout abrem modais sobre a carteira. Estados de confirmação e processamento também devem aparecer em modal/toast, sem expandir formulários permanentes dentro da tela.

Os fluxos de fundos e payout permanecem identificados como simulação local; as imagens não sugerem transferência real de dinheiro.
