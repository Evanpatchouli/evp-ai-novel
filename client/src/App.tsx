import { RouterProvider } from "react-router/dom";
import { router } from "./app/router";

/** 应用入口仅负责挂载路由，仓库会话由根布局管理。 */
export function App() {
  return <RouterProvider router={router} />;
}
