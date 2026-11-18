import { Chip } from "@ldkj/web-ui";

export function DecisionCountChip({ count }: { count: number }) {
  return (
    <Chip variant={count ? "warning" : "success"}>
      {count ? `${count} 项待决策` : "没有待决策项"}
    </Chip>
  );
}
