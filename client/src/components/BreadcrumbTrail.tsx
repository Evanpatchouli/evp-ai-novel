import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@ldkj/web-ui";
import { Fragment } from "react";
import { Link } from "react-router";

export interface BreadcrumbTrailItem {
  label: string;
  to?: string;
}

/** 使用组件库语义结构渲染不会触发整页刷新的工作台面包屑。 */
export function BreadcrumbTrail({ items }: { items: BreadcrumbTrailItem[] }) {
  return (
    <Breadcrumb aria-label="当前位置" className="breadcrumb-trail">
      <BreadcrumbList>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <Fragment key={`${item.to ?? "current"}-${item.label}`}>
              <BreadcrumbItem>
                {item.to && !current ? (
                  <Link to={item.to}>{item.label}</Link>
                ) : (
                  <BreadcrumbPage>{item.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {!current && <BreadcrumbSeparator>›</BreadcrumbSeparator>}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
