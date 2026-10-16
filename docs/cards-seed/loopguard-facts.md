---
title: Loop guard facts
tags: orch,loopguard,agy,limits,guard
description: what the guard sees and when it stops a worker
pinned: false
---
agy reports calls as tool_info.parameters (CommandLine, AbsolutePath, TargetFile). Limits: FIRST_WRITE after ~90 calls with no edit (Flash/Qwen), 60 read/grep calls since the last edit, graph-first (one graphify query before many reads, per repo), CONTEXT at 100k tokens for Qwen. A stopped session cannot be resumed: start a continuation job; the hand-off is built for you.
