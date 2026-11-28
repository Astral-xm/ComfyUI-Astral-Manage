# ComfyUI-Astral-Manage

## 使用教程

- （B 站）：https://space.bilibili.com/176339505
- （YouTube）：https://www.youtube.com/@Astral%E6%98%9F%E8%8A%92

作者：**Astral星芒** · 许可证：**AGPL-3.0** · 节点与界面中的原作者信息不得删除或替换

ComfyUI 自定义节点与资产管理合集，包含 `LoRA Stack Loader`、`String Mode Selector`、`SetGroup` / `GetGroup`、提示词与 API 对话节点、`Prompt Processor`、本地 GGUF 对话，以及通过 ComfyUI 侧边栏“资产管理”图标打开的资产管理器。资产管理器顶部的 `ComfyUI-Astral-Manage` 标题可点击打开 GitHub 发布页。

## 功能一览

| 模块 | 节点分类 | 功能 |
| --- | --- | --- |
| `LoRA Stack Loader` | `AssetManagement` | 多 LoRA 堆叠加载，每个 LoRA 最多附带 6 个触发词 |
| `String Mode Selector` | `Astral/Utilities` | 单选模式提示词并输出字符串 |
| `SetGroup` / `GetGroup` | `Astral/Set & Get` | 用分组保存和读取中间值 |
| 提示词 / 对话节点 | `Astral/Prompt` | 提示词库、API 对话与本地 GGUF 对话 |
| `Prompt Processor` | `Astral/Prompt` | 节点内配置 API / 本地 GGUF 的可折叠提示词对话节点 |
| `Prompt Skill Loader` | `Astral/Prompt` | 从节点包或本机文件加载 Skill，供提示词专家使用 |
| 直角曲线 | ComfyUI 设置 → 连线渲染模式 | 正交走线、圆角拐弯、平行线自动分道 |
| `Asset Manager` | 侧边栏“资产管理”图标 | 提示词、媒体、模型、LoRA 的统一管理 |

## 安装

### 通过 ComfyUI-Manager（推荐）

在 ComfyUI-Manager 中搜索 **ComfyUI-Astral-Manage**，即可安装或更新。

本包已提供 Comfy Registry 标准元数据。发布到 Comfy Registry 后，ComfyUI-Manager 会检测新版本并提供更新；在此之前可使用下方的 Git URL 安装。

### 通过 Git URL 安装

在 ComfyUI-Manager 中选择“通过 Git URL 安装”，填入：

```text
https://github.com/Astral-xm/ComfyUI-Astral-Manage
```

### 手动安装

将仓库克隆或解压到：

```text
ComfyUI/custom_nodes/ComfyUI-Astral-Manage
```

重启 ComfyUI。`LoRA Stack Loader` 的部分交互复用了已安装的 `rgthree-comfy` 的对话框和菜单样式。

## 依赖

默认功能不额外安装 pip 包，使用的都是 ComfyUI 自带组件：

| 依赖 | 用途 |
| --- | --- |
| `Pillow` | 图片读取、缩略图与遮罩处理 |
| `aiohttp` | Asset Manager 的 HTTP 路由 |
| `requests` | C站 / Hugging Face / 魔搭社区查询 |
| `torch`、`numpy` | 节点运行时 |

仓库根目录的 `requirements.txt` 只包含说明和可选依赖，不会安装额外包。

可选依赖：

- `llama-cpp-python`：本地 GGUF 对话，安装方式见下节。
- `ffmpeg`：聊天附件视频抽帧，需要位于系统 `PATH`。
- `rgthree-comfy`：`LoRA Stack Loader` 的对话框与菜单样式；未安装时节点仍可正常使用。

### 本地 GGUF 对话

本地 LLM 模式需要 `llama-cpp-python`，并把主模型放在 ComfyUI 的 `models/LLM` 目录中。建议按当前 Python、CUDA 和平台安装对应的预编译轮子，而不是在普通 `pip install` 中强制编译：

```powershell
python -m pip install llama-cpp-python
```

也可以使用项目可选依赖：

```powershell
python -m pip install -e ".[local-llm]"
```

若使用 GPU，请优先使用与当前 CUDA 环境匹配的 `llama-cpp-python` 预编译包；首次加载较大的 GGUF 模型可能需要明显更长时间，并占用与模型、上下文长度和卸载层数相应的内存或显存。

## LoRA Stack Loader

在 rgthree `Power Lora Loader` 的交互方式基础上，为每个 LoRA 增加最多 6 个触发词，并在加载 LoRA 的同时输出勾选的触发词。

### 输入与输出

- 可选输入：`MODEL`、`CLIP`
- 输出：`MODEL`、`CLIP`、`STRING`

触发词按 LoRA 行顺序和编号顺序输出，只输出勾选项。不同触发词使用英文半角逗号分隔，不使用空格，并且最后一项后也保留一个逗号。

示例：

```text
masterpiece,cinematic,
```

没有勾选有效触发词时输出空字符串。

### 使用

1. 点击 `Add LoRA` 添加 LoRA 行，点击 LoRA 名称选择模型。
2. 点击强度数字输入，或使用左右箭头调整强度。
3. 点击强度右侧的 `+` 添加触发词，每个 LoRA 最多 6 个；触发词固定每行两个。
4. 点击触发词输入区域编辑文字，点击编号或复选框控制是否输出。
5. 右击 LoRA 行或触发词区域会显示与 rgthree 源节点一致的菜单。
6. 点击 LoRA 行内的 `i` 打开模型详情窗口，可查看 C站、Hugging Face、魔搭社区的可点击模型页，以及自动汇总的推荐强度和触发词。
7. 点击 `Fetch model details` 会同时查询 C站、Hugging Face 和魔搭社区。C站结果会按本地文件 SHA256 精确匹配；Hugging Face 和魔搭会验证候选仓库的文件哈希，并在界面标出匹配级别。C站缺少推荐强度或触发词时，会依次尝试从 Hugging Face、魔搭的模型卡读取。推荐强度只在详情窗口展示范围，不修改节点中的强度；触发词会自动填入节点。失败时窗口保留并显示具体原因，不会关闭当前 ComfyUI 页面。
8. 将 `STRING` 输出连接到需要字符串输入的节点。

LoRA 开关只控制模型加载；触发词是否输出由各自的勾选框控制。

推荐信息按 C站、Hugging Face、魔搭的顺序选择；触发词独立执行相同顺序。C站只使用描述中的推荐/建议权重，或示例图中该 LoRA 版本的实际权重。Hugging Face 和魔搭只从文件 SHA256 精确匹配仓库的模型卡中读取明确标注的推荐权重、`instance_prompt` 或触发词字段。推荐强度始终只用于展示，节点中的强度由用户手填；触发词可以使用拉取结果自动填入。没有可靠数据时不会修改现有触发词，并会显示“未找到可靠推荐强度/触发词”。

Hugging Face 和魔搭的候选即使按名称或 Safetensors 元数据找到，只要文件哈希未确认，就不会自动把模型卡参数写入节点，避免把其他变体的推荐值误用到当前 LoRA。

Hugging Face 与魔搭的改名识别按以下顺序进行：

1. 使用本地文件 SHA256，在候选仓库的文件树中核对模型文件。
2. 读取 `.safetensors` 头部 `__metadata__` 中的标题、输出名等字段，并作为搜索别名。
3. 如果 C站已按 SHA256 精确命中，使用 C站的标准模型名引导 Hugging Face / 魔搭搜索。
4. 以上都未命中时，才回退到本地文件名候选。

界面会分别显示 `SHA256 精确匹配`、`Safetensors 元数据候选`、`C站哈希对应的名称引导候选` 或 `名称候选，未经文件哈希确认`。只有第一种是文件级确定匹配。

## String Mode Selector

用一个单选开关选择当前要输出的模式提示词，不需要连接任何输入节点。

### 输入与输出

- 输入：无。
- 输出：一个 `STRING` 端口。

### 使用

1. 右击节点并选择“属性面板”。
2. 在属性面板的“模式数量（1–20）”中选择模式数量，最多 20 个。
3. 为每个模式填写“模式 N 标题”和“模式 N 提示词”。标题会显示在节点内部。
4. 点击节点中的模式行或其右侧开关，切换当前输出。每次只能启用一个模式，最后选择的模式生效。
5. 节点底部会显示当前输出对应的模式名称，`STRING` 输出内容为当前模式的完整提示词。

模式数量、全部标题、全部提示词和当前选中的模式都会随 ComfyUI 工作流一起保存。

## SetGroup / GetGroup

`SetGroup` / `GetGroup` 通过端口名称在复杂工作流中跨距离传递任意类型的值，不需要拉出很长的连线。

节点在画布上采用 ComfyUI 原生子图输入/输出节点的侧边线样式：`SetGroup` 使用左侧圆角竖线，`GetGroup` 使用右侧圆角竖线；不显示矩形节点框、标题栏或内部文本框。端口圆点、端口名和连线仍可正常操作。

端口排版采用 ComfyUI 子工作流的输入/输出样式：`SetGroup` 的名称位于圆点右侧，`GetGroup` 的名称位于圆点左侧；文字使用与原生插槽一致的 `12px Inter` 字体。

节点的侧边线颜色跟随 ComfyUI 分配给节点的颜色；在节点颜色菜单中修改颜色后，输入/输出侧边线会同步变色。

### SetGroup

- 每个 `SetGroup` 可以同时接入多个不同类型的命名字段，例如同一个节点同时接 `MODEL`、`CLIP`、`IMAGE` 或 `AUDIO`。
- 每接上一个输入后，末尾会自动增加一个 `*` 空输入，可继续连接其他接口；断开连线后多余的未连接端口会自动合并，只保留末尾一个空输入；侧边线会随有效端口数量自动纵向收缩或伸展。
- 每个输入首次连接时自动继承上游输出的名称和数据类型，例如 `images` / `IMAGE`。
- 已连接输入圆点继承上游类型颜色，例如 `MODEL` 为蓝色、`CLIP` 为黄色、`IMAGE` 为绿色；未连接的空端口显示为单个灰色圆点，不显示 `+` 或端口名。
- 从侧边线、端口名或节点透明区域开始拖动，都会交给 ComfyUI 原生节点拖动逻辑，节点、端口和所有连线会一起移动。
- 单击端口名的上半区会向上移动该端口，单击下半区会向下移动；端口名、圆点和连线端点会同步移动到新行，为避免与双击冲突，移动会在短暂延迟后执行。
- 双击端口名会打开 ComfyUI 画布原生的 `Slot name` / `OK` 输入条，可直接修改该端口的名称。
- 右键已连接的端口会显示 ComfyUI 子工作流风格的 `Disconnect Links`、`重命名接口`、`Remove Slot` 菜单；空圆点不打开端口菜单。
- 拖动 `SetGroup` / `GetGroup` 时不显示白色吸附边界框。
- `SetGroup` 只有命名输入端口，没有输出端口；`GetGroup` 按名称读取这些输入并生成自己的输出。
- `SetGroup` 默认宽度为 `80`。升级到当前版本后，旧工作流中保存的节点宽度会一次性缩为原来的一半（最低为 `80`），之后可继续手动调整。
- 右键节点并选择“重命名 SetGroup 端口”可分别修改各个通道名称；重名会自动编号，例如 `images_2`。
- 右键菜单还可让所有 `GetGroup` 刷新。

### GetGroup

- 右键节点并选择“编辑 GetGroup 端口名”，会打开画布原生的 `Slot name` / `OK` 输入条；可输入一个或多个 `SetGroup` 名称，例如 `image, alpha, seed`，并支持中英文逗号、分号和换行分隔。
- 每个名称会生成一个同名、同类型的输出，并自动解析到对应的 `SetGroup` 来源。
- 将某个输出连接到目标节点后，节点会自动增加下一个空输出，可继续连接其他 SetGroup 端口。
- 右击任意输出圆点可选择当前已连接输入的所有 SetGroup 端口；已绑定的端口带 `✓`，已用于其他输出的端口会禁用。
- 在同一输出上改选类型兼容的 SetGroup 端口时会保留原有目标连线，也可从该菜单单独移除当前输出。
- 右侧圆角竖线会随输出数量自动伸展并包住全部输出端口。
- 名称匹配不区分大小写，但输出会继承 `SetGroup` 中的真实拼写和类型。
- 最多生成 30 个输出；名称重复会自动合并。
- 同名 `SetGroup` 无法确定来源时不会静默接错；已有输出保存了 SetGroup 节点身份时会优先沿用该来源。
- `SetGroup` 新增、改名、删除或更换类型后，`GetGroup` 会自动刷新；输出顺序变化时会尽量恢复原有目标连线。
- 从节点输入口松开连线时，原生连线菜单会增加“获取设置节点组”；选择后会创建 `GetGroup`，优先匹配输入类型并接回目标端口。
- 从节点输出口松开连线时，原生连线菜单会增加“添加 设置节点组”；选择后会创建 `SetGroup` 并自动接上来源。
- SetGroup/GetGroup 节点在 ComfyUI 节点信息中归属 `ComfyUI-Astral-Manage`，不会显示为 `frontend_only`。
- 即使先创建空名称或暂未找到来源的 `GetGroup`、之后再创建同名 `SetGroup`，原有目标连线也会尽量保留。
- 旧版 `setGroupId` 和旧输出端口名称会在载入工作流时自动迁移为新的名称列表。
- 旧工作流中保存的 `name` / `ports` 文本框参数会继续保留并用于迁移，但不再显示在节点画布上。

## Prompt Processor

`Prompt Processor` 是多轮对话节点：API / 本地 GGUF 配置全部写在节点上，不再读取资产管理器的全局 API 或本地 LLM 配置。节点始终以对话方式工作，没有扩写/反推/自由对话的模式切换。

### 面板结构

- **原生控件**（与 ComfyUI 其它节点一致）：`mode`（`api` / `local`）、`multi_turn`、`seed` 直接以普通控件行显示。
- **API 配置**（可折叠）：最多 5 组 API 配置，每组包含名称、基础地址、API 密钥、模型；用下拉框切换当前启用组，选中组保存在 `api_active`。每组的“拉取模型”按钮会调用 `/models` 列出可用模型并填入候选列表。通用生成参数包括温度、Top P、最大输出 Token、携带历史轮数、频率/存在惩罚、响应格式、推理强度；随机种子统一使用节点上的原生随机种子控件（API 与本地模式共用）。密钥会随工作流明文保存，分享工作流前请先清空；密钥可以留空，供不需要鉴权的本地兼容接口使用。
- **本地 LLM 配置**（可折叠）：模型与 mmproj 下拉框（来自 `ComfyUI/models/LLM`）、`n_ctx`、`n_batch`、`n_ubatch`、最大生成长度、携带历史轮数、温度、Top P、Top K、Min P、重复/频率/存在惩罚、GPU 层数、CPU 线程、图片最大边、JPEG 质量、Context Checkpoints、Flash Attention、KV Cache K/V、推理强度、启用思考、mmap、清理显存。节点始终不输出思考内容。
- **对话**（可折叠）：左侧会话列表（新建/删除会话、切换会话，随工作流保存；双击会话可重命名，手动命名的标题不会被首条消息覆盖），右侧消息列表、输入框、发送/清空、状态行，布局参考 MiniMax H3 Multimodal Chat（不显示 API Key）。每条消息显示角色、时间，并提供“复制”“删除”。只有 skill 端口已连接且“多轮对话”开启时，输入框和发送按钮才可用；否则会显示对应提示并禁用。
- 自定义面板里的每个参数都可以悬浮查看说明。
- 节点可纵向拉伸：多出来的高度会自动分给对话消息区；折叠或展开区域时下边线跟随内容变化，不会留下空白。
- 两个折叠区的开合状态、多轮历史与全部配置都随工作流保存；折叠后节点按内容收缩，不再保留大片空白。

### 输入端口与输出

- 端口位于输入端最上方，顺序为 `system_prompt`（STRING）、`skill`（`QWEN_TE_SKILL`）、`user_prompt`（STRING）。
  - `system_prompt` 连接后作为系统提示词；`skill` 接 `Qwen llama TE Skill加载器`（可从该插件 `skills` 目录选择 Skill，也可加载本机任意 `.md` / `.txt`），其正文与系统提示词一起放在消息最前面，之后才是用户提示词。
  - `user_prompt` 连接后覆盖对话面板中输入的消息；未连接时使用面板内容。
  - 加载器选“自动选择”时本节点不会自行匹配，请固定选择 Skill 或直接加载文件。
- 其余输入：`chat_history`（面板维护）、上述配置项，以及最多 9 张图片、3 个视频、3 个音频；媒体会作为附件随当前用户消息一起发送。
- 输出：`prompt`（从回复中清洗出的提示词，优先取代码块）、`reply`（模型原始回复）、`chat_history`（更新后的历史 JSON）、`report`（模式、启用配置组、Skill、历史轮数等摘要 JSON）。

### 行为

1. 对话需要同时满足“skill 端口已连接”和“多轮对话已开启”；缺失任一条件时节点会报错，界面也会提示并禁用输入。API 模式携带的历史轮数由“携带历史轮数”控制，本地模式沿用本地配置里的轮数。
2. 更换 Skill（端口给出不同的 Skill 文件）会清空当前对话并重新开始。
3. 对话区“发送”会把本节点及其上游节点排队执行一次，回复到达后自动刷新消息列表。
4. API 模式使用当前启用组的基础地址、密钥和模型；本地模式使用节点内选择的 GGUF 与上述参数，参数覆盖仅作用于本次运行，不会写入磁盘配置。
5. 新拖入的节点使用推荐默认参数且 API 为空；复制节点或整个工作流会把已填写的 API / LLM 配置一并复制过去。

## Prompt Skill Loader

`Prompt Skill Loader` 负责把 Skill 送进 `Prompt Processor`（也可接 Qwen llama TE 节点）：

- `skill` 下拉框只列出本插件 `skills/` 目录中的 Skill（默认该目录为空，放入 `my-skill/SKILL.cn.md` 或 `SKILL.md` 后即出现在下拉框）。其他位置的 Skill 请用节点上的“加载 Skill 文件”按钮选择，或在资产管理器“Skill 管理”里点“放入画布”。
- 节点下方按钮“加载 Skill 文件”可从本机任意位置读取 `.md` / `.txt`；“清除文件”会同时清掉临时文件与固定路径，回到下拉框选择。
- 输出类型为 `QWEN_TE_SKILL`，与 Qwen llama TE 的加载器完全兼容；Skill 正文会随输出同时提供，因此跨节点包使用时不依赖文件路径。
- 资产管理器“Skill 管理”里每张卡片新增“放入画布”按钮：把当前画布居中放置一个已固定该 Skill 路径的加载器节点，并自动选中（卡片仍覆盖所有节点包与 input 目录中的 Skill）。
- 加载文件时会校验扩展名与 4 MB 上限；路径由“放入画布”固定时，节点状态显示“已固定：文件名”。

## Asset Manager

点击 ComfyUI 侧边栏中的“资产管理”图标即可打开。管理器不注册独立节点，包含“提示词管理”、“媒体管理”和“模型管理”三个页签。

把鼠标悬停在该图标上会弹出快捷浮层：`models`、`custom_nodes`、`input`、`output`、`workflows` 五个按钮可直接在系统文件管理器中打开对应目录；“填充缺失模型”会立即扫描当前工作流中失效的模型下拉值，并按 SHA256、原路径或唯一同名自动填充，结果显示在浮层内。自动填充只修改当前工作流，不会保存或改动本地模型文件。

管理器以悬浮窗口显示，四周的 ComfyUI 画布仍可正常查看和操作；拖动窗口顶部标题栏可调整位置。

默认按 `Ctrl + Alt + M` 可以打开或关闭资产管理器，无需先点击侧边栏的“资产管理”图标。该组合避开 ComfyUI 常用编辑/画布快捷键、浏览器高频快捷键和 Windows 常用系统快捷键；面板关闭时，在输入框、文本框或其他 Astral 对话框中按键不会触发，面板已打开时再次按同一快捷键会关闭。

管理器右上角（页签行右侧）提供作者主页、更新下载、中/英切换和“快捷键”按钮；“快捷键”按钮的提示中会显示当前组合。点击后可录入新的快捷键，保存后立即生效；设置保存在当前浏览器中，关闭管理器或刷新页面后仍可使用。“恢复默认”会切回 `Ctrl + Alt + M`。

### 提示词管理

资产管理器顶部有“提示词管理”“媒体管理”“模型管理”“API 对话”四个页签；提示词管理包含“提示词灵感”“系统提示词管理”“Skill 管理”三个子页。API 配置不再单独占页签，可从 API 对话页的“打开 API 配置”或“本地 LLM 配置”按钮进入，配置页右上角的“返回 API 对话”会回到聊天界面。

#### 系统提示词管理

- 每个模板包含标题、提示词正文和分类；分类默认提供文本、图片、音频、视频、提示词扩写、图像反推。工具栏的“管理分类”可以添加自定义分类或移除分类；分类下仍有模板时无法移除，“提示词扩写”和“图像反推”是内置规则分类，始终保留。
- “提示词扩写”和“图像反推”是内置的系统提示词分类，便于归类扩写和反推提示词；它们属于内置规则分类，在分类管理中不能删除。
- 支持按标题、分类或正文关键词筛选。
- 支持新建、编辑、删除和复制模板正文。
- 可将任一模板通过 `System Prompt` 节点一键放到当前 ComfyUI 画布；节点标题和正文会自动填入，并输出 `STRING`。

### API 对话（独立页签）

- 使用 OpenAI 兼容的 `/chat/completions` API，可保存最多 20 组 API；每组分别配置名称、API 地址、默认模型和 API Key。
- API 标签可直接拖动调整顺序，松手后自动保存。
- API 配置按三种模式分工：“纯文本模式”用于翻译、提示词扩写与优化，“图片模式”用于图像反推提示词，“多模态模式”用于识别图片、视频和音频。每种模式可分别选择 API 与模型，模型留空时使用所选 API 的默认模型。
- 模型名称可手动填写，也可通过 OpenAI 兼容的 `/models` 接口拉取后选择。
- API 配置页提供全局通用生成参数：Temperature、Top P、最大输出 Token、携带历史轮数、频率/存在惩罚、可选 API Seed、停止序列、响应格式、推理强度和通用系统提示词。这些参数供纯文本、图片、多模态三种外部 API 模式共用。
- API Seed 留空时不会发送；响应格式和推理强度为“默认”时也不会发送。接口不认识可选参数时会自动移除这些字段后重试。
- API 对话支持多轮上下文，并可从 `input`、`output` 中选择图片、音频和视频附件。每个对话最多保留 30 个素材；视频会按时间顺序抽取最多 6 帧交给支持视觉输入的模型。
- 图片模式会请求 `image` 与 `text` 两种输出，并可从 API 返回的 content parts、图片字段、URL、data URL、Base64 或 Markdown 图片中接收生成结果。生成图片保存在 `output/assets-astral-chat/<会话 ID>/`，并作为 AI 消息附件持久化。若服务不支持输出模态字段，会自动兼容重试。
- 对话会自动保存历史、附件和所选 Skill，可新建、切换、重命名和删除会话。
- 用户与 AI 消息分别显示发送和接收时间。发送后按钮会变为“停止”；点击后会同时中止浏览器请求和服务端请求。
- 每条持久化消息都支持一键复制和删除，删除前会明确提示不可恢复。停止操作后，已停止的消息会继续显示，可复制或删除。
- 系统提示词和 Skill 只能加载一种，每种最多加载一个；可以互相切换。加载的系统提示词、Skill、素材标签按“系统提示词 → Skill → 素材”排序。
- 可加载 Skill；Skill 正文和 `references` 目录中的说明文件会作为系统上下文加入普通对话请求。
- 对话模式包含“纯文本模式”“图片模式”“多模态模式”和“本地模式”。本地模式调用 `models/LLM` 中的 GGUF 主模型；选择配套的 mmproj 视觉投影模型后，可识别图片、视频抽帧，Gemma4 还可识别音频。
- 纯文本操作和未附带素材的对话使用“纯文本模式”；带图片、视频或音频附件的对话使用“多模态模式”；“提示词反推”使用“图片模式”，并需要先在页面选择图片或视频附件。
- 发送按钮左侧有“翻译模式”开关和目标语言开关。目标语言只有“简体中文”和“English”两项，默认简体中文。
- 翻译模式严格遵守隔离规则：只把本次输入段落和固定翻译指令发给当前选择的文本 API 或本地 GGUF 模型，不发送会话历史、当前加载的系统提示词、Skill 或素材。译文仍会作为当前会话的一轮用户消息和助手回复保存。

API Key 只会以掩码形式回传到浏览器，不会在页面中回显明文。

#### API 配置（从 API 对话进入）

- API配置页统一管理外部 API 与本地 LLM；本地 GGUF 模型和参数位于外部 API 配置下方。所有 API 和本地 LLM 参数标题都提供鼠标悬停说明。
- 每个模式可分别选择 API 和模型；模型列表可通过对应的 OpenAI 兼容 `/models` 接口刷新拉取。
- API Key 在保存后只以掩码形式返回。API 配置保存在 `ComfyUI 用户目录/assets-astral/api-config.json`。

##### 本地 LLM 配置

- 扫描 ComfyUI `models/LLM` 目录及其子目录中的 `.gguf` 文件，也可识别 ComfyUI 注册的 `LLM` 模型目录。
- `mmproj` 使用独立下拉框选择，不会混入主模型列表；主模型与 mmproj 需要来自同一模型系列。
- 不需要视觉能力时可将 mmproj 设为“无（纯文本）”；图片、视频抽帧和 Gemma4 音频必须选择匹配的 mmproj。
- 可选择模型并配置上下文长度 `n_ctx`、`n_batch`、`n_ubatch`、最大输出 Token、历史轮数、Temperature、Top P、Top K、Min P、重复/频率/存在惩罚、GPU 卸载层数、CPU 线程、Seed、图片最大边和 JPEG 质量。
- 高级参数包括 Flash Attention、KV Cache K/V 的 Q8_0 量化、启用/保留思考、Qwen3.8 推理强度、mmap 和 Context Checkpoints。
- Qwen3.8 和 Gemma4 在保留默认采样值时，会自动采用与 `comfyUI-llama-TE` 一致的推荐值；手动修改后的参数会保留。
- `GPU 层数 = -1` 表示尽可能把全部层卸载到 GPU；`CPU 线程 = 0` 表示交给运行时自动决定。
- 配置保存在 `ComfyUI 用户目录/assets-astral/local-llm-config.json`。模型实例会按模型路径和加载参数缓存，参数变化时释放旧实例。
- 点击 ComfyUI 的“释放显存/释放内存”会同时关闭当前缓存的本地 GGUF 与 `mmproj` 实例；如果本地模型正在回复，会等当前推理结束后再释放。
- 本地 LLM 配置不再包含默认系统提示词；如需系统提示词，请从“系统提示词管理”加载到当前会话。
- 本地普通对话支持当前会话的系统提示词、单个 Skill 和历史上下文。图片和视频需要 mmproj；音频仅支持 Gemma4，并需要匹配的 BF16 mmproj。开启翻译模式后，本地模型只执行严格翻译，不读取上述上下文。
- 如果未安装 `llama-cpp-python`、模型文件不存在、模型不是 GGUF 或运行时加载失败，页面会显示具体错误原因。

#### Skill 管理

- 同时扫描 ComfyUI `custom_nodes` 与 `input` 目录树中的 Skill，每个 Skill 子目录可放一个 `SKILL.md`。
- `custom_nodes` 中的 Skill 保持原有 ID；`input` 中的 Skill 使用 `input/...` 命名空间，并在卡片上标明来源。
- 同一目录同时存在 `SKILL.cn.md` 和 `SKILL.md` 时，优先读取 `SKILL.cn.md`。
- 支持查看 Skill 正文、大小、描述和 `references` 文件列表，并打开 Skill 所在目录。
- 可从 Skill 管理页直接刷新；首次打开对话时也会等待 Skill 扫描完成，无需再点第二次。
- 支持按 Skill 名称、ID、描述、来源或文件名搜索。

#### 提示词灵感

- 初次安装默认创建“人物”“场景”“服饰”“道具”四个分类，每类预置 12 个参考提示词小助手的常用标签。
- 分类支持二级子分类。“人物”默认包含数量、性别、年龄、肤色、身材、发型、表情、动作；“服饰”默认包含上衣、裤子、套装、鞋、饰品；“场景”默认包含天气、时间、光照、镜头视角、地点。
- 可通过分类旁的 `+` 新建子分类或批量新增标签；二级分类旁的 `+` 只在该二级分类下批量新增标签，分类树最多两级。
- 批量新增支持每行一个标签，也支持使用英文逗号、中文逗号或分号分隔。一次只会写入当前分类或当前二级分类，重复名称自动跳过，并统一写入一次标签数据。
- 二级分类支持重命名、删除和在同一父分类内拖拽排序。
- 新建或编辑标签时可选择二级分类。删除二级分类只会把其中的标签移回该父分类的“未分类”，不会删除标签、收藏或原有标签数据。
- 标签只用于提供视觉提示词灵感，不用于标记、归类或筛选 Skill。
- 可跨分类多选一批标签；也可使用“随机组合”从 2–4 个不同分类各抽取一个标签，再次点击可换一批。
- 每张标签卡片都有独立的批量管理复选框；勾选不会改变“加入灵感”的选择。支持全选当前结果和清空勾选。
- 可批量删除勾选标签，或把它们统一移动到目标分类、目标二级分类或该分类的“未分类”。目标分类已有同名标签时会自动跳过，不会覆盖原标签。
- 输入基础画面想法后，可把所选标签自然扩写为文生图或文生视频提示词，并选择英文或中文输出。文生视频会额外考虑动作变化、镜头运动、节奏、光影和空间连续性。
- 灵感扩写可在页面切换“API纯文本模式”和“本地模式”：API纯文本模式使用“纯文本模式”API 与模型，本地模式使用“API配置”底部的本地 GGUF 模型。
- 两种模式共用同一套内置扩写规则，不受 API 配置的系统提示词或“提示词扩写”模板影响。
- 生成结果可以继续编辑、复制、作为新的基础想法再次扩写，或加入 API 对话。
- 支持新增、重命名、删除分类和标签，设置标签颜色、收藏标签，以及拖拽调整分类、二级分类和标签顺序。
- 标签数据继续保存在兼容文件 `skill-tags.json` 中；旧版仅含空“通用”分类的默认数据会自动迁移，用户已有的自定义分类、标签和旧版 Skill 分配数据都会保留，但 Skill 分配不再出现在界面中，也不参与 Skill 搜索或对话上下文。

提示词模板、API 配置、本地 LLM 配置和会话默认保存在 `ComfyUI 用户目录/assets-astral`（例如 `ComfyUI/user/assets-astral`）。`api-config.json` 含本地保存的 API Key，请勿随工作流派发此目录。

### 媒体管理

- 与模型管理共用一致的工具栏、目录树、筛选和文件列表布局。
- 递归读取 ComfyUI `input`、`output` 中的图片、视频和音频。
- 可浏览 `input`、`output` 文件夹结构。
- 可通过 ComfyUI 服务端所在系统的文件管理器打开 `input`、`output`、当前文件夹或定位单个素材。Windows 使用资源管理器，macOS 使用 Finder，Linux 桌面使用 FileManager1 兼容文件管理器。
- 打开和定位完成后会请求把对应文件管理器窗口置前：Windows 使用资源管理器窗口激活，macOS 使用 Finder 的 `activate`，Linux 在 FileManager1 之后会尝试通过 `wmctrl` 或 `xdotool` 激活已经显示的 X11 文件管理器窗口。
- Linux 的目录打开依赖系统 `xdg-open`（通常由 `xdg-utils` 提供）；精确定位优先使用 `gdbus` 或 `dbus-send`。文件管理器不支持 FileManager1 时会自动退回到打开文件所在目录。`wmctrl` 和 `xdotool` 都是可选增强项，未安装时仍可正常打开文件管理器。无图形桌面的 Linux 服务器无法显示文件管理器。
- Wayland 桌面出于安全设计通常不允许后台程序绕过系统强制抢焦点；此时由 FileManager1 和桌面环境负责激活窗口。如果桌面仍阻止置前，需要在桌面设置中允许文件管理器获取焦点，或改用 X11 会话。
- 支持按关键词、来源和图片/视频/音频类型筛选。
- 素材卡片支持多选、清空选择，以及全选/反选当前路径下的全部匹配文件；尚未通过滚动加载显示的文件也会纳入选择范围。
- 删除或改名完成后会把素材列表补加载到操作前的已显示数量，避免浏览进度退回第一页。
- 选中单个素材可重命名；重命名不能修改文件扩展名。
- 选中多张图片可按统一前缀递增改名，例如 `image1.png`、`image2.webp`，每张图片保留自己的扩展名。
- 选中的素材可批量移至 Windows 回收站；前端使用不阻塞页面的自定义确认弹窗，后端仍会校验明确确认标记。
- 图片可放大预览；视频可播放预览；音频可直接试听。视频缩略图需要系统可用的 `ffmpeg`。
- 读取 PNG 内嵌的 ComfyUI API Prompt、UI Workflow，以及同名 `.json`、`.workflow.json` 元数据。
- 视频提示词优先读取 `ffprobe` 可见的媒体标签；没有元数据时明确显示为空。
- 复制素材绝对路径和提示词。
- 图片可尝试复制到系统剪贴板，非 PNG 图片会先转换为 PNG。
- 浏览器通常不允许写入视频文件到剪贴板；失败时保留预览窗口并显示浏览器返回的原因。
- 加载素材内嵌的 ComfyUI UI 工作流。
- 插入官方 `LoadImage` 或 `LoadVideo` 节点。`output` 素材会自动使用 `[output]` 路径注解。

服务端只返回 `input`、`output` 内的媒体文件，并拒绝绝对路径、`..` 路径穿越、符号链接逃逸和非媒体文件。

### 模型管理

- 模型分类严格镜像 ComfyUI `models` 目录的实际一级文件夹，并直接显示磁盘上的原名，不做中文翻译或别名替换。
- 只注册在 `folder_names_and_paths`、但物理位置不在 `models` 下的一级目录会被排除，例如字体和 LUT，避免显示与模型管理无关的内容。
- 可浏览每个模型分类的根目录和文件夹结构；启动器把模型目录设为目录联接或符号链接时，只要 ComfyUI 能解析到实际 `models` 根目录，仍按该根目录中的一级文件夹原名显示。
- 支持模型文件搜索、分页、复制绝对路径。
- LoRA 管理使用与媒体管理一致的左侧目录树和面包屑导航；根目录显示真实文件夹名（例如 `loras`），可逐级进入 LoRA 子文件夹。
- 右侧会递归列出当前目录及其全部子目录中的 LoRA，进入子目录后面包屑显示完整路径。
- LoRA 支持单选或批量选择、移动到其他 LoRA 文件夹、移至 Windows 回收站，以及用官方 `LoraLoader` 节点放入当前画布显示区域。
- Windows、Linux 和 macOS 共用同一套内部 `/` 路径格式；放入画布时会按 ComfyUI 后端所在系统自动转换为原生路径分隔符，Windows 为 `\`，Linux/macOS 为 `/`。因此从其他系统的浏览器远程访问时也能正确识别子目录 LoRA。
- LoRA 的“全选/反选”会递归读取当前目录及子目录的全部匹配文件，不受尚未加载显示的分页影响；移动到目标文件夹时不会覆盖同名文件。
- 可扫描重复模型：先按文件大小分组，再计算 SHA256。扫描作为后台任务运行并显示文件数、字节进度、速度和预计剩余时间；关闭管理器不会中断，重新打开会自动接入任务，也可随时取消。
- 普通模型文件可移至 Windows 回收站；操作前必须确认，且不会删除模型目录。
- 把鼠标悬停在侧边栏“资产管理”图标上，可一键扫描当前画布中的缺失模型：检查节点模型下拉框里已经不在 ComfyUI 选项中的模型值，并在本地 `models` 目录中查找同哈希或同名文件。
- 工作流带有 SHA256 时只接受哈希一致的文件；即使存在同名文件，哈希不一致也会标记为冲突并阻止按名称替代。没有可用哈希时，才按规范相对路径或同名文件匹配。
- 唯一同名文件、原相对路径或哈希一致的可靠项会在扫描后自动填充；多个同名文件和哈希冲突只报告、不替换。填充后只修改当前画布，不会保存工作流，也不会复制、移动或删除模型文件。
- LoRA 来源面板可批量选择本地 LoRA，每批最多查询 30 个，前端自动拆分请求。
- LoRA 来源同时覆盖 C站、Hugging Face 和魔搭社区。
- 是否显示 LoRA 缩略图可通过“显示缩略图”开关控制，偏好保存在浏览器本地。

- C站按本地文件 SHA256 精确匹配模型，返回 C站链接、推荐强度和触发词。
- Hugging Face 和魔搭社区会搜索候选仓库，并核对候选仓库内 `.safetensors` 文件的 SHA256；命中时返回模型页和匹配到的仓库文件。
- 推荐强度和触发词按 C站、Hugging Face、魔搭的顺序回退；最终值会显示实际来源。
- Hugging Face 使用批量路径信息接口核对 `LFS OID/SHA256`，并兼容文件树分页；魔搭使用仓库文件接口核对 `Sha256`。
- 未命中文件哈希时，结果会明确标记为 Safetensors 元数据候选、C站名称引导候选或名称候选，不会冒充 SHA256 精确匹配。
- 单个来源失败不会影响其他来源；每张来源卡片显示可读的失败原因。
- 可对选中项强制刷新，绕过 15 分钟服务端缓存。
- 查询成功后，来源、推荐强度、触发词和模型版本等信息会保存到 LoRA 同目录的 `<LoRA文件名>.json`，缩略图保存为 `<LoRA文件名>.preview.<扩展名>`；JSON 字段兼容 NB 启动器的 LoRA 信息文件。
- 如果 LoRA 同目录已有同名 JSON，但它不是 LoRA 信息文件，则 Astral 数据会改存到 `<LoRA文件名>.astral.json`，不会覆盖原文件。重启 ComfyUI 后，LoRA 列表会自动恢复这些本地数据，无需重新联网查询。
- 强制刷新失败时，页面显示本次失败原因，但磁盘中上一次成功的来源、触发词、推荐强度和缩略图不会被覆盖。

`YuE2`、`yue2` 等名称如果出现在列表中，可能对应磁盘上真实存在的模型子目录；只要位于 `models` 的一级文件夹下，就会按其原名显示，不会被前端隐藏或删除。

## 连线样式：直角曲线

本包在 ComfyUI 的连线渲染模式中新增 **直角曲线**：

1. 打开 ComfyUI 设置，找到“连线渲染模式”（`Comfy.LinkRenderMode`）。
2. 选择“直角曲线”。

效果：

- 端口先水平走出一段再拐弯：预留 15px，其中 10px 是水平直段、5px 用于圆角半径，保证拐弯前已经水平走了至少 10px。
- 输出端口向右水平引出；输入端口强制从左侧水平接入。反向或过短连线通过端口之间的 U 形绕行保证接入方向；绕行 Y 按 10px 步进扫描，优先避开节点和已有线束。
- 反向绕行时源/目标节点主体也参与避让，仅两端 15px 端口水平段豁免。
- 不再要求在中点附近拐弯。走线从输出端向右扫描，选择最早一个既不被节点覆盖、也没有被其他线束占用的竖直通道。
- 所有弯折必须落在“输出端口右 15px”和“输入端口左 15px”围成的矩形区域内，不再向端口外侧绕行。
- 节点按实际尺寸向外扩展 5px 作为避让区；只有找不到空闲通道时，才回落到覆盖最少、最靠前的路径。
- 输出端与输入端纵向差 ≤10px 且横向距离 ≥10px 时直接走直线，不做弯折。
- 在背景连线层绘制，节点会遮挡连线，与“直角线”一致。
- 箭头、中心点和连线点击检测会跟随新路径。

如果安装了 Mk-tools 画布工具并启用了“悬停显示连线”等自定义连线样式，直角曲线模式会在绘制时临时让 Mk-tools 使用核心连线渲染，绘制结束后立即恢复原设置。

## HTTP 接口

```text
GET  /assets-astral/assets
GET  /assets-astral/assets/detail
GET  /assets-astral/assets/file
GET  /assets-astral/assets/thumbnail
GET  /assets-astral/assets/tree
POST /assets-astral/assets/open
POST /assets-astral/assets/rename
POST /assets-astral/assets/recycle
GET  /assets-astral/prompts
GET  /assets-astral/prompt-templates
POST /assets-astral/prompt-templates
POST /assets-astral/prompt-templates/delete
GET  /assets-astral/chat/config
POST /assets-astral/chat/config
GET  /assets-astral/chat/conversations
POST /assets-astral/chat/models
POST /assets-astral/chat/conversations
GET  /assets-astral/chat/conversations/get
POST /assets-astral/chat/conversations/update
POST /assets-astral/chat/conversations/delete
POST /assets-astral/chat
POST /assets-astral/chat/cancel
POST /assets-astral/chat/translate
POST /assets-astral/chat/messages/delete
POST /assets-astral/prompt-task
GET  /assets-astral/local-llm/config
POST /assets-astral/local-llm/config
GET  /assets-astral/local-llm/models
POST /assets-astral/local-llm/chat
GET  /assets-astral/skills
GET  /assets-astral/skills/content
GET  /assets-astral/loras
GET  /assets-astral/loras/info
POST /assets-astral/loras/sources
POST /assets-astral/loras/sources/cached
GET  /assets-astral/loras/thumbnail
GET  /assets-astral/models
GET  /assets-astral/models/categories
GET  /assets-astral/models/tree
POST /assets-astral/models/duplicates
POST /assets-astral/models/missing/resolve
POST /assets-astral/models/recycle
GET  /assets-astral/thumbnails/proxy
```

### UI language

The panel and the node definitions use English as their source language. The
Chinese translation is applied only when ComfyUI's language setting
(`Comfy.Locale`) starts with `zh`; node names and tooltips come from
`locales/zh/nodeDefs.json`, and panel strings from `web/astral_i18n_dict.js`.
The language button in the Asset Manager still stores a per-browser override.

### API host policy

`POST /assets-astral/chat/models` only reads the provider id from the request
body: the base URL and the API key always come from the saved configuration, and
a saved key is only sent back to the base URL it was entered for. Changing a
base URL clears the stored key. Upstream failures are reported by HTTP status
only, and redirects are not followed.

Operators can pin the allowed API hosts with the
`ASTRAL_MANAGE_API_ALLOWED_HOSTS` environment variable, a comma-separated list
of `host`, `host:port` or `*.domain` entries. When it is unset, any public host
is allowed except reserved and link-local addresses. URLs with an embedded
username or password are always rejected.

## 已知限制

- `LoadVideo` 是否可用取决于当前 ComfyUI 版本和已安装节点。管理器会在插入时明确报错。
- 改名识别依赖本地 `.safetensors` 元数据、C站精确命中或候选仓库可被公开检索。本地文件被重命名、元数据被移除且 C站无记录时，只能返回名称候选，无法保证找到原模型。
- Hugging Face 与魔搭的搜索或文件哈希接口若要求登录、限流或返回异常，会在对应网址行显示失败原因；其他来源仍可正常显示。
- C站网络访问、登录限制、区域限制和 API 频率限制都可能造成查询失败，界面会显示原因。
- 视频剪贴板取决于浏览器和操作系统；多数 Chromium 浏览器不支持视频 MIME 写入系统剪贴板。
- API 模型必须兼容 OpenAI Chat Completions 请求格式；图片、音频和视频理解还要求所选模型支持对应的多模态输入。
- 本地模式的主模型当前要求 GGUF。图片和视频需要手动选择匹配的 mmproj；音频仅支持 Gemma4，并同样需要 mmproj。
- 本地模型的上下文长度、最大输出和历史轮数会共同影响内存/显存占用；参数过高时可能加载失败或推理显著变慢。
- 翻译模式按设计不继承会话历史、系统提示词、Skill 或素材，因此需要依赖上下文才能理解的段落应先补全为独立文本。
- `Prompt Processor` 是多轮对话节点，支持会话切换、消息复制与删除；历史轮数由节点上的“携带历史轮数”控制，不写入资产管理器的 API 对话。
- 视频附件抽帧需要系统可用的 `ffmpeg`；音频附件受所配置 API 的音频格式支持情况限制。
- Skill、模板和会话属于本机数据，不会自动同步到其他 ComfyUI 实例。

## 发布新版本（维护者）

1. 修改 `pyproject.toml` 中的 `version`；确认 `PublisherId` 与 registry.comfy.org 上的发布者 ID 一致。
2. 在 registry.comfy.org 创建发布者并生成 API Key。
3. 安装 comfy-cli：`python -m pip install comfy-cli`
4. 在仓库根目录运行 `comfy node publish`，按提示输入 API Key。
5. 发布成功后，ComfyUI-Manager 会通过 Comfy Registry 检测新版本并提供更新。

## 许可与署名

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布。你可以在遵守许可证的前提下使用、修改和分发；通过网络提供服务时也必须提供完整源代码。

依据 AGPL-3.0 第 7(b) 条，作者附加要求：**不得删除、隐藏或替换节点、界面和源代码中的原作者署名“Astral星芒”及项目名称**。完整条款见 [NOTICE.md](NOTICE.md)，许可证全文见 [LICENSE](LICENSE)。

