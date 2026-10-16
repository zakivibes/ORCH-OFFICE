---
title: Write first, read little
tags: qwen,alibaba,rebuild,panel,widget,ui
description: Qwen reads for 60+ calls and writes nothing
pinned: false
---
Your first file must exist within 10 calls. Read the spec once, never re-read the prototype or other panels. Create new widget files under lib/widgets/room_game/<game>/ one per spec section, then swap only the build tree of the panel (find lines with grep -n). Run dart analyze after each file.
