// 5分おきに自動で実行され、予定時刻になっていれば出品します
import { tick } from "../lib/core.mjs";

export default async () => {
  const result = await tick();
  console.log(JSON.stringify(result));
};

export const config = { schedule: "*/5 * * * *" };
