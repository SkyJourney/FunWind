"""节日装扮执行器（M14 D2/D9）：按农历/公历规则确保 campaigns 里有当前或下一年的时间窗。

语义（与 §3.5 字段清单的实现差异，见 M14 文档 §12 执行记录）：
- 没有「提前生成提前量」字段：任务每次执行都确保「当前或下一年」的窗口存在——窗口必然提前于
  生效时刻生成（campaigns 是读取侧惰性判定，不依赖提前量），提前量在 ensure 语义下无意义。
- 生成走 SSR 内部动作接口（D8 三保险：nginx 公网 404 + token + campaigns 写服务校验/审计），
  接口是 **create-if-absent**：同名同 effect 的方案已存在（含站长微调过的）一律不动——管线绝不
  覆盖站长对当年方案的编辑；改规则后要刷新当年窗口时，在 /admin/campaigns 微调该行，或删除该行
  后手动触发任务重新生成。

窗口：[节日日 - beforeDays, + durationDays)，左闭右开，与 campaigns 读取口径一致。
目标年：今天 ≤ 今年窗口结束 → 今年；否则明年（农历年按农历年锚定，跨公历年自然成立）。

规则参数（任务 params，web 侧 zod 与此同构，双端夹具守护）：
  calendar: "solar" | "lunar"；month: 1–12；day: 公历须为该月真实日期（1–28/29/30/31，闰日 2/29
  不支持——候选年无闰日时会持续空转失败）/ 农历 0–30（0 = 月末，如除夕；30 遇小月由窗口计算
  顺延到下一年）；beforeDays: 0–30（默认 0）；durationDays: 1–90（默认 7）；
  items: 1–6 个 {effect, target}，effect 限视觉类三键（theme.pack / site.logo / site.hero），
  target 是各 effect 的选项值（包 id / 池文件名）。effect 键集合与 web 侧 campaigns 注册表同步，
  两端各自维护（新生成效果须两边同时加）。
"""
import json
import logging
import urllib.error
import urllib.request
from datetime import date, timedelta

from lunar_python import Lunar, LunarMonth

from . import config, ledger

log = logging.getLogger("ops.holiday")

CALENDARS = ("solar", "lunar")
KNOWN_EFFECTS = frozenset({"theme.pack", "site.logo", "site.hero"})
MAX_ITEMS = 6
SSR_TIMEOUT = 15  # 写服务走 campaigns 事务（含审计），给足余量
# 公历每月天数（2 月按闰年上限计；闰日本身被 check_params 单独拒绝，见下）
SOLAR_DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


class RuleError(ValueError):
    """节日规则参数不合法（加载时跳过该任务并在健康状态里报告）。"""


def check_params(raw: dict) -> dict:
    """结构性校验 + 应用默认值，返回规范化后的 params；不合法抛 RuleError。

    effect 键只做集合内检查与去重；target 的语法/存在性由 SSR 写服务按 effect 注册表校验
    （fail-closed：未知 target 在生成时报错进台账，不影响其他任务）。
    """
    unknown = set(raw) - {"calendar", "month", "day", "beforeDays", "durationDays", "items"}
    if unknown:
        raise RuleError(f"未知参数：{', '.join(sorted(unknown))}")
    calendar = raw.get("calendar")
    if calendar not in CALENDARS:
        raise RuleError(f"calendar 须为 solar 或 lunar：{calendar!r}")
    month, day = raw.get("month"), raw.get("day")
    if not isinstance(month, int) or isinstance(month, bool) or not 1 <= month <= 12:
        raise RuleError(f"month 须为 1–12 的整数：{month!r}")
    day_low, day_high = (0, 30) if calendar == "lunar" else (1, 31)
    if not isinstance(day, int) or isinstance(day, bool) or not day_low <= day <= day_high:
        raise RuleError(f"{calendar} 历的 day 须为 {day_low}–{day_high} 的整数：{day!r}")
    # 真实日历校验（R-20）：公历 day 须在该月存在；闰日只在闰年存在，按年循环的候选年
    # 大多无此日（任务会持续失败告警），配置期直接拒绝并给出替代写法
    if calendar == "solar":
        if month == 2 and day == 29:
            raise RuleError("公历 2 月 29 日（闰日）只在闰年存在，按年循环规则请改用 2 月 28 日")
        if day > SOLAR_DAYS_IN_MONTH[month - 1]:
            raise RuleError(f"公历 {month} 月没有 {day} 日")

    def bounded(key: str, low: int, high: int, default: int) -> int:
        value = raw.get(key, default)
        if value is None:
            return default
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise RuleError(f"{key} 须为 {low}–{high} 的整数：{value!r}")
        return value

    items = raw.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
        raise RuleError(f"items 须为 1–{MAX_ITEMS} 个装扮内容")
    seen: set[str] = set()
    normalized_items = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"effect", "target"}:
            raise RuleError(f"装扮内容须为 {{effect, target}}：{item!r}")
        effect, target = item["effect"], item["target"]
        if effect not in KNOWN_EFFECTS:
            raise RuleError(f"未知的装扮效果：{effect!r}")
        if not isinstance(target, str) or not 1 <= len(target) <= 120:
            raise RuleError(f"装扮 {effect} 的 target 须为 1–120 字符：{target!r}")
        if effect in seen:
            raise RuleError(f"装扮效果重复：{effect}")
        seen.add(effect)
        normalized_items.append({"effect": effect, "target": target})

    return {
        "calendar": calendar,
        "month": month,
        "day": day,
        "beforeDays": bounded("beforeDays", 0, 30, 0),
        "durationDays": bounded("durationDays", 1, 90, 7),
        "items": normalized_items,
    }


def fest_date(calendar: str, year: int, month: int, day: int) -> date:
    """节日在某（农历/公历）年的公历日期；农历 day=0 = 该农历月最后一天（除夕）。

    该年不存在此日期时抛 RuleError（公历超月天数；农历 30 日遇 29 天小月，因年而异），
    由 compute_window 顺延到下一个候选年。"""
    if calendar == "solar":
        try:
            return date(year, month, day)
        except ValueError as exc:
            raise RuleError(f"公历 {month} 月没有 {day} 日") from exc
    if day > 0:
        days = LunarMonth.fromYm(year, month).getDayCount()
        if day > days:
            raise RuleError(f"农历 {year} 年 {month} 月只有 {days} 天（没有 {day} 日）")
    solar = (
        Lunar.fromYmd(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1)
        .getSolar()
        .nextDay(-1)
        if day == 0
        else Lunar.fromYmd(year, month, day).getSolar()
    )
    return date(solar.getYear(), solar.getMonth(), solar.getDay())


def compute_window(params: dict, today: date) -> dict:
    """目标窗口：今天 ≤ 今年窗口结束 → 今年；否则明年。返回 {year, start, end}（datetime.date）。

    候选年不存在该节日日期（如农历 30 日遇小月）→ 顺延到下一个候选年；两年都无 → RuleError。"""
    before, duration = params["beforeDays"], params["durationDays"]
    for year in (today.year, today.year + 1):
        try:
            fest = fest_date(params["calendar"], year, params["month"], params["day"])
        except RuleError:
            continue
        start = fest - timedelta(days=before)
        end = start + timedelta(days=duration)  # 左闭右开：窗口含 [start, end) 的天
        if end > today:  # end 当天窗口已过期（NOW() ≥ ends_at 时读取侧不再生效）
            return {"year": year, "start": start, "end": end}
    raise RuleError("今年与明年都算不出该节日的日期（农历小月无此日？）——请调整规则")


def _wall(day: date) -> str:
    return day.strftime("%Y-%m-%d 00:00:00")


def ensure_campaign_window(
    params: dict,
    task_name: str,
    *,
    trigger: str,
    task_key: str = "campaign.holiday",
    run_id: int | None = None,
    ssr_base_url: str | None = None,
) -> dict:
    """确保目标窗口的 campaigns 行存在（create-if-absent，逐条 effect）。

    台账生命周期与备份执行器一致：先校验规则，再插 running 行，任何失败收尾为 failed；
    返回含 run_id 的结果摘要。节日生成不占用备份互斥锁：写路径是幂等的 create-if-absent
    HTTP，无共享资源竞争。"""
    rule = check_params(dict(params))  # 校验前置：坏规则不产生台账行
    run_id = run_id if run_id is not None else ledger.insert_run("holiday", trigger, task_key)
    try:
        base = (ssr_base_url or config.SSR_BASE_URL).rstrip("/")
        window = compute_window(rule, date.today())
        token = config.OPS_TOKEN
        notes = []
        created = 0
        existing = 0
        # 方案名 = 任务名·年份；任务名截前 50 字（SSR 侧方案名上限 60，超长会被 422 拒绝）
        name = f"{task_name[:50]}·{window['year']}年"
        for item in rule["items"]:
            body = json.dumps(
                {
                    "name": name,
                    "effect": item["effect"],
                    "target": item["target"],
                    "startsAt": _wall(window["start"]),
                    "endsAt": _wall(window["end"]),
                },
                ensure_ascii=False,
            ).encode("utf-8")
            request = urllib.request.Request(
                f"{base}/api/internal/campaigns/holiday",
                data=body,
                method="POST",
                headers={"Content-Type": "application/json", "x-ops-token": token},
            )
            try:
                with urllib.request.urlopen(request, timeout=SSR_TIMEOUT) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                detail = ""
                try:
                    detail = str(json.loads(exc.read().decode("utf-8")).get("error", ""))[:200]
                except Exception:
                    pass
                raise RuntimeError(
                    f"装扮 {item['effect']} 写入被 SSR 拒绝（HTTP {exc.code}）：{detail or exc.reason}"
                ) from exc
            except Exception as exc:
                raise RuntimeError(f"装扮 {item['effect']} 写入失败（SSR 不可达？）：{exc}") from exc
            if not result.get("ok"):
                raise RuntimeError(f"装扮 {item['effect']} 写入异常：{str(result)[:200]}")
            action = "已存在" if result.get("existing") else "已生成"
            notes.append(f"{item['effect']} {action}（campaign id={result['id']}）")
            created += 0 if result.get("existing") else 1
            existing += 1 if result.get("existing") else 0
    except Exception as exc:
        ledger.finish_run(run_id, "failed", error=str(exc)[:1000])
        raise
    detail = f"{window['year']} 年窗口 {window['start']} 起：" + "；".join(notes)
    ledger.finish_run(run_id, "success", detail=detail)
    log.info("节日装扮完成：%s", detail)
    return {
        "run_id": run_id,
        "year": window["year"],
        "start": _wall(window["start"]),
        "end": _wall(window["end"]),
        "created": created,
        "existing": existing,
        "detail": detail,
    }
