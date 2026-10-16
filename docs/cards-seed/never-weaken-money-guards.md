---
title: Money guards stay
tags: money,wallet,bet,gift,vip,payout,balance
description: never weaken them, even to make a test pass
pinned: true
---
Never change an existing money value or payout. Keep every double-send guard (_isSending*/busy), the non-purchasable block, the shared confirm + recharge step before a chip is sent, and the mic rule in rooms. New money keys are placeholders behind the owner-confirm gate. If a test asserts a guard that moved, update the test to the new file, never delete the guard.
