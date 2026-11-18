import { useState } from "react";
import { Collapse, Icon } from "@ldkj/web-ui";
import { Link } from "react-router";
import type { DocumentTreeNode } from "../../../../shared/contracts";
import { authorityLabel } from "../../domain/authority";

function DocumentDirectory({ node }: { node: DocumentTreeNode }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <Collapse
      accordion
      collapsible
      bordered={false}
      variant="plain"
      size="sm"
      activeKey={expanded ? node.path : null}
      onChange={(key) => setExpanded(key !== null)}
      expandIconPosition="start"
      expandIcon={() => (
        <span className="document-tree-chevron" aria-hidden="true">
          <Icon name="chevron_right" size={16} />
        </span>
      )}
    >
      <Collapse.Item value={node.path}>
        <Collapse.Trigger className="document-tree-directory">
          {node.name}
        </Collapse.Trigger>
        <Collapse.Content
          className="document-tree-branch"
          role="group"
          {...{ inert: expanded ? undefined : "" }}
        >
          {node.children?.length ? (
            <ul className="document-tree-children">
              {node.children.map((child) => (
                <TreeItem key={child.path} node={child} />
              ))}
            </ul>
          ) : null}
        </Collapse.Content>
      </Collapse.Item>
    </Collapse>
  );
}

function TreeItem({ node }: { node: DocumentTreeNode }) {
  return (
    <li>
      {node.kind === "directory" ? (
        <DocumentDirectory node={node} />
      ) : (
        <Link
          className="document-tree-file"
          title={node.path}
          to={`/documents/view?path=${encodeURIComponent(node.path)}`}
        >
          <span>{node.name}</span>
          <small>{authorityLabel(node.authority)}</small>
        </Link>
      )}
    </li>
  );
}

/** 可折叠且键盘可达的仓库文档目录树。 */
export function DocumentTree({ nodes }: { nodes: DocumentTreeNode[] }) {
  return (
    <nav className="document-tree" aria-label="文档目录树">
      <ul>
        {nodes.map((node) => (
          <TreeItem key={node.path} node={node} />
        ))}
      </ul>
    </nav>
  );
}
