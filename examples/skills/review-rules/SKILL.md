---
name: review-rules
description: 按团队规范评审改动：只看正确性与安全，按严重程度排序
version: 1.2.0
tools: read_file, search, git_diff
---

# 评审规则

1. 先看 `git_diff` 再下结论，**不要相信实现者的自述**。
2. 只报两类问题：**正确性**与**安全性**；风格、命名不在此列。
3. 结论分三档输出：「必须修」「建议修」「可以通过」。
4. 每条结论必须给 `路径:行号` 与一句为什么。
5. 拿不准的地方标注「需人工确认」，不要编造。

参考 `templates/checklist.md` 里的检查清单。
