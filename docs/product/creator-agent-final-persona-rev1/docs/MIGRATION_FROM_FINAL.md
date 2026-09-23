# 旧FINAL → PERSONA-REV1：只更正人格能力，不重开项目

## 替换决定

删除“账号只用一套、联系人不得更换人格”的永久限制。替换为：账号默认＋Agent/子Agent可固定绑定＋手动换装＋关系级定制/自动生成；每轮解析一份有效快照。六模板不是六个Agent，更不是数量上限。

## 保留

北极星原文、DeerFlow、同一主要Lead、社交认知与自然交流、世界材料、真实身份、关系记忆、既有插件、TurnResult/发送回执/接管、Jev可关闭。旧参考代码中的PersonaBinding冻结只表示单次运行值对象，不能用它阻止新的绑定版本。

## 最小迁移

1. 现有persona_id/version一对一迁入账号默认profile，不抹除关系或已发消息。
2. 新增可选Agent/子Agent覆盖、关系覆盖、绑定revision、生效时间和变更原因。迁移没有这些字段的记录时保持继承，不擅自为所有联系人重配。
3. 本包六模板的策略元数据为1.0.1。生产旧1.0.0仍保留在注册表；要采用新版本时显式记录变更，不给旧版本原地换内容。现有关系级显式覆盖不被账号默认修改覆盖。
4. 解析器优先级固定，context/candidate/send均携带有效persona指纹；回滚重新指向旧profile且revision递增。
5. generate_profile按需接真实模型，候选与已启用分开。局部明确偏好可以在既有授权下自动落本范围，无需逐条审批。
6. 不并发改SOUL.md。子Agent可加载同一profile解析器；长期聊天负责人及关系记忆由宿主绑定，不依赖临时task默认拥有记忆。

## 覆盖文件

主规格、开工指令、PERSONALITY_SYSTEM、README、NORTH_STAR、实施地图、六模板策略字段、人格目录、当前回合/认知/候选提示、JevChat评审措辞、评测说明和原persona_stability判据已同步。新增profile/binding合同、解析参考、fixture、预览脚本和回归测试。

## 开工入口

只以本包CODING_AGENT_PROMPT.md为准；旧FINAL/更早文档不并行生效。先完成固定/换装/关系生成并跑自然多轮，再按原工作包接记忆与业务。不要只打上“支持人格切换”标签而真实模型仍接旧prompt。
