import "@/modules";
import { z } from "zod";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk, parseManageQuery } from "@/lib/manage/route";
import { readSettingsGroup, SETTINGS_GROUPS } from "@/lib/settings/groups";

export const dynamic = "force-dynamic";

const querySchema = z.object({ group: z.string().max(64).optional() });

/** GET /api/manage/settings：设置分组脱敏读（白名单；缺省返回分组索引） */
export const GET = manageEndpoint(
  async ({ request }) => {
    const q = parseManageQuery(request, querySchema);
    if (q.group) {
      const read = await readSettingsGroup(q.group);
      // Result 形态：未知白名单组 404（不泄露组清单外的键空间）
      if (!read.ok) throw new ManageApiError("not_found");
      return manageOk({
        group: read.group,
        key: read.key,
        value: read.value,
        updatedAt: read.updatedAt,
      });
    }
    return manageOk({ groups: Object.keys(SETTINGS_GROUPS) });
  },
  { endpoint: "settings" },
);
