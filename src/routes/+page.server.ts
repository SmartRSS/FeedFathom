import {
  NodeType,
  type TreeNode,
  type TreeSource,
} from "../types/source-types";

export const load = async ({ locals }) => {
  if (!locals.user) {
    return {
      tree: [],
    };
  }

  const [userSources, userFolders] = await Promise.all([
    locals.dependencies.userSourcesRepository.getUserSources(locals.user.id),
    locals.dependencies.foldersRepository.getUserFolders(locals.user.id),
  ]);

  const folderLookup: { [key: string]: TreeSource[] } = {};
  const sourcesWithoutFolder: TreeSource[] = [];

  for (const source of userSources) {
    const sourceData: TreeSource = {
      favicon: source.favicon,
      homeUrl: source.homeUrl ?? "",
      name: source.name,
      type: NodeType.SOURCE,
      uid: source.id?.toString() ?? "",
      unreadCount: source.unreadArticlesCount,
      xmlUrl: source.url ?? "",
    };
    if (source.parentId) {
      const stringId = source.parentId.toString();
      if (!folderLookup[stringId]) {
        folderLookup[stringId] = [];
      }

      folderLookup[stringId].push(sourceData);
    } else {
      sourcesWithoutFolder.push(sourceData);
    }
  }

  const treeFromDatabase: TreeNode[] = userFolders.map((folder) => {
    return {
      children: folderLookup[folder.id.toString()] ?? [],
      name: folder.name,
      type: NodeType.FOLDER,
      uid: folder.id.toString(),
    };
  });

  treeFromDatabase.push(...sourcesWithoutFolder);

  return { tree: treeFromDatabase };
};
