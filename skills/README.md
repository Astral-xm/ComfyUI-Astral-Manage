# Skills

把 Skill 放在本目录下，`Prompt Skill Loader` 的 `skill` 下拉框会自动列出这里的 Skill。

每个 Skill 使用一个子目录，并在其中放置 `SKILL.cn.md` 或 `SKILL.md`：

```text
skills/
  my-skill/
    SKILL.cn.md
    SKILL.md
    references/
      notes.md
```

- 目录名建议使用 `A-Z a-z 0-9 . _ -`，它会成为 Skill ID 的一部分。
- `SKILL.cn.md` 优先于 `SKILL.md`；文件开头的 YAML frontmatter 可写 `name` 与 `description`。
- 只扫描本目录，不会扫描其他节点包的 `skills`；其他位置的文件请在节点上点“加载 Skill 文件”选择，或在资产管理器里用“放入画布”。
