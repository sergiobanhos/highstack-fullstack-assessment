# HighStack player UI references

These images are visual references for the local player experience. They show individual screens or states; modal flows are represented with one modal open at a time. The implemented React UI has evolved and does not need to match every reference pixel-for-pixel.

## Authentication

- `auth-login.png` — sign in
- `auth-register.png` — create an account

## Game

- `game-betting-open.png` — a round accepting bets
- `game-running.png` — a live round with an active bet
- `game-cashout-complete.png` — confirmed cashout dialog
- `game-crashed.png` — round ended by a crash
- `game-reconnecting-cashout-unknown.png` — upstream reconnecting while a cashout outcome is unknown

## Wallet and simulated payouts

- `wallet-overview.png` — wallet balance and history
- `wallet-top-up-modal.png` — local test top-up form
- `wallet-top-up-success.png` — test top-up confirmation
- `wallet-top-up-unknown.png` — top-up confirmation unavailable; tells the player to read the existing operation before creating another
- `wallet-payout-modal.png` — payout request form
- `wallet-payout-processing.png` — payout in progress
- `wallet-payout-complete.png` — simulated payout completed
- `wallet-payout-validation-error.png` — payout form validation error
- `wallet-payout-unknown.png` — payout confirmation unavailable; tells the player to check the existing request

Top-up and payout are local simulations. The references do not imply that real money is sent or received.

## Frontend assets

- `../../client/public/assets/highstack-logo.png` — supplied HighStack logo
- `../../client/public/assets/highstack-background.png` — abstract dark background texture

Dynamic content such as round graphs, amounts, buttons, and dialogs should be rendered as UI components rather than raster images.

## Visual direction

The references use graphite and dark green, restrained emerald glow, and turquoise accents. Wallet actions open dialogs over the wallet screen. Success, processing, validation, and unknown outcomes are distinct states so the interface can communicate what has and has not been confirmed.
