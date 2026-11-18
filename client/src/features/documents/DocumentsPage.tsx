import { useEffect, useState } from "react";
import { Alert, Button, Chip, Input } from "@ldkj/web-ui";
import { Link } from "react-router";
import type { DocumentTreeNode } from "../../../../shared/contracts";
import { api, type DocumentSearchResult } from "../../api";
import { useRepositorySession } from "../../app/RepositorySession";
import { AsyncButton } from "../../components/AsyncButton";
import { PageHeader, Panel } from "../../components/layout";
import { EmptyState, ErrorState } from "../../components/states";
import { authorityLabel } from "../../domain/authority";
import { DocumentTree } from "./DocumentTree";

export function DocumentsPage() {
  const { showNotice } = useRepositorySession();
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState<DocumentTreeNode[]>([]);
  const [treeBusy, setTreeBusy] = useState(true);
  const [treeError, setTreeError] = useState("");
  const [results, setResults] = useState<DocumentSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void api
      .documentTree()
      .then((loaded) => !cancelled && setTree(loaded))
      .catch((cause) => {
        if (!cancelled) setTreeError(cause instanceof Error ? cause.message : "无法读取文档树");
      })
      .finally(() => !cancelled && setTreeBusy(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const search = async () => {
    setBusy(true);
    setError("");
    try {
      setResults(await api.documents(query));
      setSearched(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "搜索失败");
    } finally {
      setBusy(false);
    }
  };

  const openDocument = async (path: string, target: "folder") => {
    try {
      await api.open(path, target);
      showNotice({
        tone: "success",
        message: "已请求打开所在目录。",
      });
    } catch (cause) {
      showNotice({
        tone: "error",
        message: cause instanceof Error ? cause.message : "打开文档失败",
      });
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="分级文档浏览"
        title="查资料，不混淆事实等级"
        description="正文和圣经优先；规划仅代表意图，归档内容会明确警告。"
        actions={
          <div className="inline-actions">
            <Button className="button-link" component={Link} to="/novel" variant="outline">
              小说元数据
            </Button>
            <Button className="button-link" component={Link} to="/documents/new" variant="outline">
              新建文档
            </Button>
          </div>
        }
      />
      <div className="document-library-layout">
        <Panel title="目录树" description="按仓库权威目录浏览">
          {treeBusy ? (
            <p className="muted-copy">正在读取目录树…</p>
          ) : treeError ? (
            <Alert variant="warning" description={treeError} />
          ) : tree.length ? (
            <DocumentTree nodes={tree} />
          ) : (
            <EmptyState label="没有可浏览的文档" />
          )}
        </Panel>
        <Panel title="搜索文档" description="搜索文件名和 Markdown 正文">
          <form
            className="search-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <Input
              aria-label="搜索仓库文档"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入人物、地点、术语或文件名"
            />
            <AsyncButton type="submit" variant="primary" busy={busy}>
              搜索
            </AsyncButton>
          </form>
          {error && <ErrorState message={error} />}
          {results.length ? (
            <div className="document-results">
              {results.map((result) => (
                <article key={result.path}>
                  <div>
                    <Chip
                      size="sm"
                      variant={
                        result.authority === "canonical" || result.authority === "bible"
                          ? "success"
                          : result.authority === "archive"
                            ? "danger"
                            : "default"
                      }
                    >
                      {authorityLabel(result.authority)}
                    </Chip>
                    <h2>{result.title}</h2>
                    <small>{result.path}</small>
                  </div>
                  {result.excerpt && <p>{result.excerpt}</p>}
                  {result.warning && <Alert variant="warning" description={result.warning} />}
                  <div className="inline-actions">
                    <Button
                      className="button-link"
                      component={Link}
                      to={`/documents/view?path=${encodeURIComponent(result.path)}`}
                      size="sm"
                      variant="outline"
                    >
                      阅读文档
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void openDocument(result.path, "folder")}>
                      打开所在目录
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            !busy &&
            !error &&
            (searched ? (
              <EmptyState label="没有匹配的文档" detail="请尝试其他关键词；空关键词可浏览权威文档索引。" />
            ) : (
              <EmptyState label="尚未搜索" detail="输入关键词查找资料，或直接搜索以浏览权威文档索引。" />
            ))
          )}
        </Panel>
      </div>
    </>
  );
}
