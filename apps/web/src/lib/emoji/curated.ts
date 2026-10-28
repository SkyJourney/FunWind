/**
 * 精选 Unicode emoji（M10.8 Step 7）：编辑器表情面板的内置数据，永远存在、后台不可改（站长 2026-10-28 定）。
 *
 * 口径：只收社区常用、各平台字体普遍支持（Unicode 13 及以前）的单码位 / 带 VS16 的 emoji；
 * 不含国旗、职业与家庭等 ZWJ 组合序列（体积大、字体支持参差）。分类 9 个，约 490 个。
 * 每条写成一行 `"😀 名称 关键词…"`：第一个词是 emoji，第二个是中文名，其余是搜索关键词（中英文皆可）。
 * emoji 后面紧跟 `*` 表示支持肤色修饰（只有手势与人物）。
 */

export interface EmojiItem {
  /** emoji 字符（不带肤色） */
  char: string;
  /** 中文名（悬浮提示与搜索） */
  name: string;
  /** 搜索关键词（小写） */
  keywords: string[];
  /** 是否支持肤色修饰 */
  skin: boolean;
}

export interface EmojiCategory {
  id: string;
  label: string;
  /** 页签上代表本分类的 emoji */
  icon: string;
  items: EmojiItem[];
}

const SOURCES: { id: string; label: string; icon: string; raw: string }[] = [
  {
    id: "smileys",
    label: "笑脸与情绪",
    icon: "😀",
    raw: `
😀 大笑 开心 smile grin
😃 开心 高兴 happy
😄 笑眼 哈哈
😁 露齿笑 嘿嘿 grin
😆 眯眼笑 大笑 laugh
😅 汗笑 尴尬 苦笑 sweat
🤣 笑到打滚 笑死 rofl lol
😂 笑哭 笑出眼泪 joy
🙂 微笑 slight smile
🙃 倒脸 反讽 upside
😉 眨眼 wink
😊 害羞微笑 脸红 blush
😇 天使 无辜 angel
🥰 爱心脸 喜爱 love
😍 花痴 爱心眼 heart eyes
🤩 星星眼 崇拜 star struck
😘 飞吻 kiss
😋 好吃 美味 yum
😛 吐舌 tongue
😜 眨眼吐舌 调皮 wink tongue
🤪 疯狂 搞怪 crazy
😝 眯眼吐舌 tongue
🤑 财迷 钱 money
🤗 拥抱 hug
🤭 捂嘴笑 偷笑
🤫 嘘 安静 shush
🤔 思考 想想 thinking
🤐 闭嘴 拉链 zip
🤨 挑眉 怀疑 raised eyebrow
😐 无语 面无表情 neutral
😑 无奈 expressionless
😶 无言 沉默 speechless
😏 得意 坏笑 smirk
😒 不屑 嫌弃 unamused
🙄 翻白眼 eye roll
😬 龇牙 尴尬 grimace
🤥 说谎 pinocchio
😌 安心 释然 relieved
😔 失落 低落 pensive
😪 困 犯困 sleepy
🤤 流口水 drool
😴 睡觉 zzz sleep
😷 口罩 生病 mask
🤒 发烧 体温计 sick
🤕 受伤 绷带
🤢 恶心 nauseated
🤮 呕吐 vomit
🤧 喷嚏 感冒 sneeze
🥵 热 中暑 hot
🥶 冷 冻僵 cold
🥴 晕 醉 woozy
😵 晕倒 dizzy
🤯 爆炸头 震惊 mind blown
🤠 牛仔 cowboy
🥳 派对 庆祝 party
😎 墨镜 酷 cool
🤓 书呆子 nerd
🧐 单片眼镜 审视
😕 困惑 confused
😟 担心 worried
🙁 皱眉 frown
😮 惊讶 surprised
😯 吃惊 hushed
😲 震惊 astonished
😳 脸红 flushed
🥺 恳求 可怜 pleading
😨 害怕 fearful
😰 冷汗 焦虑 anxious
😥 失望 sad sweat
😢 流泪 哭 cry
😭 大哭 sob
😱 尖叫 惊恐 scream
😞 失望 disappointed
😩 疲惫 weary
😫 累 tired
🥱 哈欠 yawn
😤 生气喷气 得意 triumph
😡 愤怒 angry
😠 生气 mad
🤬 骂人 脏话 cursing
😈 恶魔笑 devil
💀 骷髅 skull
💩 便便 poop
🤡 小丑 clown
👻 幽灵 ghost
👽 外星人 alien
🤖 机器人 robot
😺 笑猫 cat
🙈 非礼勿视 see no evil
🙉 非礼勿听
🙊 非礼勿言
`,
  },
  {
    id: "people",
    label: "手势与人物",
    icon: "👍",
    raw: `
👍* 赞 点赞 thumbs up like
👎* 踩 反对 thumbs down
👌* OK 好的 ok
✌️* 剪刀手 耶 victory peace
🤞* 祈祷 交叉手指 fingers crossed
🤟* 爱你 love you
🤘* 摇滚 rock
🤙* 打电话 call me
👈* 向左指 left
👉* 向右指 right
👆* 向上指 up
👇* 向下指 down
☝️* 食指向上 one
✋* 举手 停 stop hand
🤚* 手背 back hand
🖐️* 张开手 五指 hand
👋* 挥手 招手 你好 wave
🤏* 一点点 捏 pinch
✊* 拳头 fist
👊* 出拳 punch
👏* 鼓掌 clap
🙌* 举双手 欢呼 hooray
👐* 张开双手
🤲* 捧手 请求
🙏* 拜托 合十 谢谢 pray thanks
🤝 握手 合作 handshake
✍️* 写字 writing
💪* 肌肉 加油 strong muscle
🧠 大脑 brain
👀 眼睛 看 eyes
👂* 耳朵 ear
👃* 鼻子 nose
👄 嘴 lips
👅 舌头 tongue
🙋* 举手 提问 raising hand
🙇* 鞠躬 bow
🤦* 捂脸 facepalm
🤷* 耸肩 shrug
🙅* 不行 禁止 no
🙆* 可以 OK gesture
💁* 服务台 引导
👶* 宝宝 婴儿 baby
👦* 男孩 boy
👧* 女孩 girl
👨* 男人 man
👩* 女人 woman
👴* 老爷爷 old man
👵* 老奶奶 old woman
👮* 警察 police
💂* 卫兵 guard
👷* 工人 worker
🤴* 王子 prince
👸* 公主 princess
🎅* 圣诞老人 santa
🧙* 法师 巫师 mage
`,
  },
  {
    id: "hearts",
    label: "爱心",
    icon: "❤️",
    raw: `
❤️ 红心 爱 heart love
🧡 橙心 orange
💛 黄心 yellow
💚 绿心 green
💙 蓝心 blue
💜 紫心 purple
🖤 黑心 black
🤍 白心 white
🤎 棕心 brown
💔 心碎 broken
❣️ 感叹号心 heart exclamation
💕 两颗心 two hearts
💞 旋转的心
💓 心跳 beating
💗 增长的心 growing
💖 闪亮的心 sparkling
💘 丘比特 箭 cupid
💝 礼物心 gift
💟 心形装饰
💌 情书 love letter
💋 唇印 kiss mark
💯 一百分 满分 100
`,
  },
  {
    id: "nature",
    label: "动物与自然",
    icon: "🐶",
    raw: `
🐶 小狗 狗 dog
🐱 小猫 猫 cat
🐭 老鼠 mouse
🐹 仓鼠 hamster
🐰 兔子 rabbit
🦊 狐狸 fox
🐻 熊 bear
🐼 熊猫 panda
🐨 考拉 koala
🐯 老虎 tiger
🦁 狮子 lion
🐮 奶牛 cow
🐷 小猪 pig
🐸 青蛙 frog
🐵 猴子 monkey
🐔 鸡 chicken
🐧 企鹅 penguin
🐦 小鸟 bird
🐤 小鸡 chick
🦆 鸭子 duck
🦉 猫头鹰 owl
🐺 狼 wolf
🐴 马 horse
🦄 独角兽 unicorn
🐝 蜜蜂 bee
🐛 毛毛虫 bug
🦋 蝴蝶 butterfly
🐌 蜗牛 snail
🐞 瓢虫 ladybug
🐜 蚂蚁 ant
🐢 乌龟 turtle
🐍 蛇 snake
🦎 蜥蜴 lizard
🐙 章鱼 octopus
🦑 鱿鱼 squid
🦀 螃蟹 crab
🐠 热带鱼 fish
🐟 鱼 fish
🐬 海豚 dolphin
🐳 鲸鱼 whale
🦈 鲨鱼 shark
🐊 鳄鱼 crocodile
🦒 长颈鹿 giraffe
🐘 大象 elephant
🐫 骆驼 camel
🐑 绵羊 sheep
🐐 山羊 goat
🐕 狗 dog
🐈 猫 cat
🦜 鹦鹉 parrot
🦢 天鹅 swan
🐾 爪印 paw
🌸 樱花 cherry blossom
🌹 玫瑰 rose
🌻 向日葵 sunflower
🌼 小花 blossom
🌷 郁金香 tulip
🌱 幼苗 seedling
🌲 松树 evergreen
🌳 大树 tree
🌴 棕榈树 palm
🌵 仙人掌 cactus
🍀 四叶草 幸运 clover
🍁 枫叶 maple
🍂 落叶 fallen leaf
🍃 树叶 leaf
🌿 草药 herb
🌍 地球 earth
🌙 月亮 moon
☀️ 太阳 sun
⭐ 星星 star
🌟 闪亮星 glowing star
🌈 彩虹 rainbow
☁️ 云 cloud
⛄ 雪人 snowman
❄️ 雪花 snowflake
⚡ 闪电 lightning
🌊 海浪 wave
🔥 火 热 fire hot
💧 水滴 drop
☔ 雨伞 下雨 rain
`,
  },
  {
    id: "food",
    label: "食物饮料",
    icon: "🍔",
    raw: `
🍎 苹果 apple
🍐 梨 pear
🍊 橘子 orange
🍋 柠檬 lemon
🍌 香蕉 banana
🍉 西瓜 watermelon
🍇 葡萄 grapes
🍓 草莓 strawberry
🍒 樱桃 cherry
🍑 桃子 peach
🥭 芒果 mango
🍍 菠萝 pineapple
🥥 椰子 coconut
🥝 猕猴桃 kiwi
🍅 番茄 tomato
🥑 牛油果 avocado
🥕 胡萝卜 carrot
🌽 玉米 corn
🥔 土豆 potato
🍞 面包 bread
🥐 牛角包 croissant
🧀 奶酪 cheese
🥚 鸡蛋 egg
🍳 煎蛋 fried egg
🥓 培根 bacon
🍔 汉堡 hamburger
🍟 薯条 fries
🍕 披萨 pizza
🌭 热狗 hotdog
🥪 三明治 sandwich
🌮 塔可 taco
🌯 卷饼 burrito
🍜 拉面 面条 ramen noodles
🍝 意面 spaghetti
🍲 火锅 炖菜 pot
🍛 咖喱饭 curry
🍣 寿司 sushi
🍱 便当 bento
🥟 饺子 dumpling
🍤 炸虾 shrimp
🍙 饭团 rice ball
🍚 米饭 rice
🍢 关东煮 oden
🍦 冰淇淋 ice cream
🍰 蛋糕 cake
🎂 生日蛋糕 birthday cake
🍮 布丁 pudding
🍭 棒棒糖 lollipop
🍬 糖 candy
🍫 巧克力 chocolate
🍿 爆米花 popcorn
🍩 甜甜圈 donut
🍪 饼干 cookie
☕ 咖啡 coffee
🍵 茶 tea
🥛 牛奶 milk
🍺 啤酒 beer
🍻 干杯 cheers beers
🥂 碰杯 香槟 champagne
🍷 红酒 wine
🍸 鸡尾酒 cocktail
🍹 热带饮料 tropical
🥤 饮料 soda
`,
  },
  {
    id: "activities",
    label: "活动与娱乐",
    icon: "🎮",
    raw: `
⚽ 足球 soccer
🏀 篮球 basketball
🏈 橄榄球 football
⚾ 棒球 baseball
🎾 网球 tennis
🏐 排球 volleyball
🏉 英式橄榄球 rugby
🎱 台球 billiards
🏓 乒乓球 ping pong
🏸 羽毛球 badminton
🥊 拳击手套 boxing
🎯 靶心 命中 target
⛳ 高尔夫 golf
🎣 钓鱼 fishing
🎮 游戏手柄 游戏 game
🕹️ 摇杆 joystick
🎲 骰子 dice
🧩 拼图 puzzle
🎰 老虎机 slot
🎳 保龄球 bowling
🎨 调色盘 美术 art
🎬 场记板 电影 clapper movie
🎤 麦克风 唱歌 mic
🎧 耳机 headphone
🎼 乐谱 music
🎹 钢琴 piano
🥁 鼓 drum
🎷 萨克斯 sax
🎺 小号 trumpet
🎸 吉他 guitar
🏆 奖杯 冠军 trophy
🥇 金牌 第一 gold
🥈 银牌 silver
🥉 铜牌 bronze
🏅 奖牌 medal
🎁 礼物 gift
🎈 气球 balloon
🎉 庆祝 彩带 tada party
🎊 彩球 confetti
🎀 蝴蝶结 ribbon
🎃 南瓜灯 pumpkin
🎄 圣诞树 christmas
🎆 烟花 fireworks
🎇 烟火 sparkler
`,
  },
  {
    id: "travel",
    label: "旅行与地点",
    icon: "✈️",
    raw: `
🚗 汽车 car
🚕 出租车 taxi
🚌 公交 bus
🚓 警车 police car
🚑 救护车 ambulance
🚒 消防车 fire truck
🚚 货车 truck
🚲 自行车 bicycle
🛵 小摩托 scooter
🏍️ 摩托车 motorcycle
✈️ 飞机 airplane
🚀 火箭 rocket
🛸 飞碟 ufo
🚁 直升机 helicopter
⛵ 帆船 sailboat
🚢 轮船 ship
🚂 火车 train
🚄 高铁 bullet train
🚅 子弹头 high speed
🏠 房子 house
🏡 带花园的房子 home
🏢 办公楼 office
🏥 医院 hospital
🏦 银行 bank
🏫 学校 school
⛪ 教堂 church
🗼 东京塔 tokyo tower
🗽 自由女神 statue of liberty
🏰 城堡 castle
🌃 夜景 night
🌆 黄昏城市 city
🌉 夜桥 bridge
🎡 摩天轮 ferris wheel
🎢 过山车 roller coaster
⛰️ 山 mountain
🏖️ 沙滩 beach
🏝️ 小岛 island
🗻 富士山 fuji
⛺ 帐篷 露营 tent camping
🧭 指南针 compass
`,
  },
  {
    id: "objects",
    label: "物件",
    icon: "💡",
    raw: `
📱 手机 phone
💻 笔记本电脑 laptop
🖥️ 台式电脑 desktop
⌨️ 键盘 keyboard
🖱️ 鼠标 mouse
💾 软盘 save floppy
💿 光盘 cd
📷 相机 camera
📹 摄像机 video camera
🎥 电影摄影机 movie camera
🎞️ 胶片 字幕 film
📺 电视 tv
📻 收音机 radio
⏰ 闹钟 alarm
⌚ 手表 watch
💡 灯泡 想法 idea bulb
🔋 电池 battery
🔌 插头 plug
🔦 手电筒 flashlight
📚 书 books
📖 打开的书 book
📝 备忘录 笔记 memo
✏️ 铅笔 pencil
📌 图钉 pin
📎 回形针 clip
✂️ 剪刀 scissors
📁 文件夹 folder
📂 打开的文件夹 open folder
📅 日历 calendar
📈 上涨 增长 chart up
📉 下跌 chart down
📊 柱状图 bar chart
🔍 搜索 放大镜 search
🔒 锁 lock
🔓 解锁 unlock
🔑 钥匙 key
🔧 扳手 wrench
🔨 锤子 hammer
⚙️ 齿轮 设置 gear
🧰 工具箱 toolbox
💰 钱袋 money bag
💳 信用卡 card
💎 钻石 宝石 diamond
📦 包裹 package
📫 信箱 mailbox
📧 邮件 email
💬 对话 speech
💭 想法气泡 thought
🔔 铃铛 bell
🔊 喇叭 speaker
📢 广播 loudspeaker
🏷️ 标签 tag
🔗 链接 link
`,
  },
  {
    id: "symbols",
    label: "符号",
    icon: "✅",
    raw: `
✅ 对勾 完成 check
❌ 叉 错误 cross
⭕ 圆圈 circle
❓ 问号 question
❗ 感叹号 exclamation
‼️ 双感叹号 double exclamation
⚠️ 警告 warning
🚫 禁止 prohibited
⛔ 禁行 no entry
🆗 OK按钮 ok button
🆕 新 new
🆒 酷 cool button
✨ 闪光 sparkles
💫 眩晕星 dizzy star
💥 碰撞 爆炸 boom
💢 怒气 anger
💦 汗滴 水 sweat drops
💨 冲刺 dash
💤 睡眠 zzz
➕ 加 plus
➖ 减 minus
➡️ 右箭头 right arrow
⬅️ 左箭头 left arrow
⬆️ 上箭头 up arrow
⬇️ 下箭头 down arrow
🔄 循环 刷新 refresh
▶️ 播放 play
⏸️ 暂停 pause
⏹️ 停止 stop
⏩ 快进 fast forward
⏪ 快退 rewind
🔴 红圆 red
🟠 橙圆 orange
🟡 黄圆 yellow
🟢 绿圆 green
🔵 蓝圆 blue
🟣 紫圆 purple
⚫ 黑圆 black
⚪ 白圆 white
✔️ 勾 heavy check
`,
  },
];

function parse(raw: string): EmojiItem[] {
  const items: EmojiItem[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const first = parts[0]!;
    const skin = first.endsWith("*");
    items.push({
      char: skin ? first.slice(0, -1) : first,
      name: parts[1]!,
      keywords: parts.slice(2).map((k) => k.toLowerCase()),
      skin,
    });
  }
  return items;
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = SOURCES.map((s) => ({
  id: s.id,
  label: s.label,
  icon: s.icon,
  items: parse(s.raw),
}));

/** 肤色修饰符（U+1F3FB–1F3FF），下标 0 表示默认（不加修饰） */
export const SKIN_TONES: readonly { label: string; modifier: string; swatch: string }[] = [
  { label: "默认", modifier: "", swatch: "👋" },
  { label: "浅肤色", modifier: "\u{1F3FB}", swatch: "👋\u{1F3FB}" },
  { label: "中浅肤色", modifier: "\u{1F3FC}", swatch: "👋\u{1F3FC}" },
  { label: "中等肤色", modifier: "\u{1F3FD}", swatch: "👋\u{1F3FD}" },
  { label: "中深肤色", modifier: "\u{1F3FE}", swatch: "👋\u{1F3FE}" },
  { label: "深肤色", modifier: "\u{1F3FF}", swatch: "👋\u{1F3FF}" },
];

/** 给支持肤色的 emoji 加上修饰符（先去掉 VS16：修饰符直接跟在基础字符后）；不支持的原样返回 */
export function applySkin(item: EmojiItem, tone: number): string {
  const mod = SKIN_TONES[tone]?.modifier ?? "";
  if (!item.skin || mod === "") return item.char;
  return item.char.replace(/️/g, "") + mod;
}

/** 按名称与关键词搜索（忽略大小写，所有词都命中才算）；空查询返回空数组 */
export function searchEmoji(query: string): EmojiItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const out: EmojiItem[] = [];
  for (const cat of EMOJI_CATEGORIES)
    for (const it of cat.items) {
      const hay = `${it.name} ${it.keywords.join(" ")}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) out.push(it);
    }
  return out;
}
