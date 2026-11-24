# OR(baseline)

这个目录从 Organon 原版复制，沿用原版的任务、评估器、候选工作器和运行时插件。ALE-Bench AHC 任务默认启用基线感知搜索。其他任务保持原版流程，可以在任务的 `task.json` 中设置 `"baseline_search": true` 启用。设为 `false` 可回到原版流程。

## 运行

按原版 [README](README.md) 在支持 Docker 的 Linux 环境安装。使用独立的 DSH profile，例如 `PROFILE=or-baseline bash setup.sh`，然后选中该 profile，在 AHC 任务目录里启动 Evolve Mode。把 [PROMPT.md](PROMPT.md) 交给 orchestrator。继续同一次运行时保持相同的 `max_budget`，分批调整 `candidates`。做对照时为每个组合复制一份干净的任务目录。

初始基线占用一次官方评估，沿用原版不扣候选槽的规则。后续候选的生成、失败、重复和诊断均占候选槽。完全重复的程序复用已有证据并跳过评估。`evolve_status` 读取最近一批结束时的报告。运行结束后用原版 `final_eval.py` 对历史最佳的正式通过候选进行私有评估。

## 改进项和对应记录

| 改进 | 实现与核对方式 |
| --- | --- |
| 主动诊断 ABD | 同一个基线下分叉做参数、局部逻辑、邻域或评价、状态表示和独立算法探测。各路线轮流进行短程后代开发。预算较少时缩短共同窗口，`matchedBudget` 记录窗口长度。 |
| 五维画像 | `profile` 记录相对竞争力 R、正向局部收益 L、结构潜力 G、家族分配集中度 C、路线不确定性 U。按任务基线分数量级归一化增益。U 使用有效样本量及近期分数波动作为代理。 |
| 四状态软路由 | 输出 SS、SE、WU、WE 概率和证据不足标记。记录在线更新的四乘四预算矩阵以及四类活动的预算权重。 |
| 受保护谱系 PELI | `archive` 记录各家族精英、孵化前沿与休眠候选。正式验证的全局历史最佳独立保留，低分结构路线获得有上限的后续开发机会。无效候选得到有限修复机会。 |
| 首代路线竞争 CFRC | 各探测路线从同一候选出发，同一窗口以实际尝试数计费。阶段结束后考虑增长、收益、不确定性与成本继续分配。 |
| 研究方向指纹 | 工作器报告家族、表示、机制、目标、假设、瓶颈、操作、证据及备选方向。完全相同的源码提前判重，重复方向降权。自然语言改写仍可能让同一假设得到不同指纹。 |
| 反事实回溯 | 停滞或假设受反证时，从决策锚点往前追溯并重新发起兄弟路线。候选提示带回旧路线和兄弟路线的记录。对同父代、同尝试窗口、有正式得分的局部参考路线记录优势。 |
| 延迟价值 | 从真实亲子边计算有界折扣信用。用路线最好成绩、近期增长、命中率、近似反事实优势、不确定性和观测成本计算调度优先级。 |
| 双重自进化 | 沿用生成及现有 provider 插槽，兼容地从其他家族引入已验证的思路。新增 `baseline_policy` 插槽允许各搜索批次之间调整策略。评估使用任务原有官方评估器。 |
| 运行与诊断 | `population.jsonl` 包含候选父代、路线锚点、方向、评估反馈、策略和评估前画像。报告包含路线比较、延迟信用、停滞、休眠、回溯和指标。 |

完整记录在任务的 `run/population.jsonl` 和 `run/baseline/report.json`。报告中的反事实优势是配对搜索结果。影响估计需要跨运行重复测量。调度成本使用生成和评估的经过时间。真实 CPU 时间和推理用量须由外部实验环境记录。

## 运行时修订策略

在两次 `evolve_run` 之间，通过原版 `evolve_define` 和 `evolve_activate` 注册策略插件。例如：

```js
export function apply(ctx) {
  const evolve = ctx.get('evolve')
  ctx.effect(() => evolve.register('baseline_policy', {
    name: 'extend-structural-incubation',
    protection: 3,
    beta: 0.9,
  }))
}
```

策略可以修改 `probes`、`estimateState`、`protection`、`routeKey`、`selectParent`、`shouldBacktrack`、`potential`、`budgetMatrix` 和 `weights`。探测计划在第一次运行时写入磁盘，保证已开始的配对窗口稳定。后续修改的探测定义参与新路线选择。普通的 `select` 自定义 provider 可用于新开局部路线。原版核心 `loop`、`mutate`、`survive` 插槽仍可用。

## 消融与对照

在每个独立任务副本的 `task.json` 中设置 `baseline_search` 对象。完整方法使用默认配置。以下每次只修改一项。

| 实验 | 设置 |
| --- | --- |
| 去除 ABD | `{"diagnosis": false}` 使用均匀状态先验，保留 CFRC 匹配试验 |
| 去除 PELI | `{"incubation": false}` 移除孵化模式及额外保护 |
| 去除 CFRC | `{"counterfactual": false}` 跳过独立竞争模式和回溯，保留 ABD 的结构探测 |
| 去除延迟信用 | `{"delayedCredit": false}` 使用单步收益 |
| 去除方向指纹调度 | `{"fingerprints": false}` 移除方向降权，仍记录指纹和完全相同的源码 |
| 固定调度 | `{"adaptiveBudget": false}` 使用固定模式权重 |
| 禁用策略自进化 | `{"policyEvolution": false}` 使用内置流程与 provider，忽略已激活的搜索策略修订。 |

对照组包括 Organon 原版、OR(seed2)、Organon + MAP-Elites、Organon + 岛屿、即时奖励 Bandit、随机重启和 ShinkaEvolve。为每道题准备基础合法解或简单贪心、基础搜索、高质量开发三档起点，只在实验清单记录档位。固定候选槽、公共实例、模型与推理上限、CPU 配额和时间。从同一份初始程序和任务评估器启动每组，给每个组合多个随机种子，私有实例只用于最后评估。外部框架需使用相同的评估入口，并实际记录推理预算与求解器时间。

报告输出最终分数、按已耗候选数的最佳分数 AUC、突破标记、跨谷比例、低分起点得到后代开发的比例、回溯恢复尝试数、重复率、方向数、单位经过时间收益。预测检验按评估前的 SE+WE 概率和后四次尝试是否提高历史最佳计算 Brier 分数。强弱档位准确率应由独立观察标签核对，不能直接用同一批探测结果生成标签，然后用它评价诊断。跨题汇总时先计算同题同起点配对差值或题内归一化。

按运行清单汇总对照可执行 `python scripts/compare_baseline_runs.py <manifest.json> --control Organon --metric finalBestScore`。清单为对象数组，每项包含 `task`、`baseline_sha256`、`baseline_level`、`seed`、`method`、`candidate_budget`、`model`、`inference_limit`、`cpu_limit`、`public_cases_sha256`、`judge_sha256`，以及相对于清单的 `report` 路径或一个 `metrics` 对象。配对按同题、同初始程序、同种子进行，条件不一致会报错。

## 验证命令

```sh
node --test plugins/dsh-evolve-loop/tests/baseline.node.test.js
cd plugins/dsh-evolve-loop
pnpm test
npm pack --offline --ignore-scripts --pack-destination ../../dist
```

