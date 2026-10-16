---
title: Hex colour ratchet
tags: color,theme,hex,ui,widget,palette,dart
description: no new Color(0x..) literals
pinned: false
---
test/phase1_foundations_test.dart caps raw Color(0x…) literals (kMaxHexColors). Put a game's palette in ONE theme file or use AppColors; never add literals inline in widgets. If the count must change, say so and why.
