# 可换装profile参考

六基础模板在personas/，本目录是独立profile与作用域绑定示例。固定到已有子Agent、管理切换、关系定制/生成使用同一种配置能力，不需六个模型。

解析从账号默认→Agent/子Agent覆盖→关系覆盖选择一个完整profile，再应用本轮临时表达调整。profile继承单一模板，较高覆盖不拼接多个底色；清除覆盖恢复上层。例子中的scope/事件都是fixture。

运行`python scripts/preview_profile.py --case account|subagent|relationship|switch|rollback`。profile_ref显示实际选定结果。五个binding文件演示独立的配置快照，不代表自动迁移序列或真实数据库变更。rollback为新revision，不会让旧草稿自动恢复有效。

reference只解析已提供记录，不负责生成、存储、授权或收发；created_by=generated的fixture是手工构造，不是假装调用模型。生产生成按prompts/PERSONA_GENERATION.md接现有模型。来源引用必须由宿主核对；schema不能判断文字是否真实合适。
