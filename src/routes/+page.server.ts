import {
  NodeType,
  type TreeNode,
  type TreeSource,
} from "../types/source-types";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
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

  userSources.forEach((source) => {
    const sourceData: TreeSource = {
      type: NodeType.SOURCE,
      name: source.name,
      uid: source.id!.toString(),
      xmlUrl: source.url || "",
      homeUrl: source.homeUrl || "",
      unreadCount: source.unreadArticlesCount,
      favicon: source.favicon,
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
  });

  const treeFromDb: TreeNode[] = userFolders.map((folder) => ({
    type: NodeType.FOLDER,
    name: folder.name,
    uid: folder.id.toString(),
    children: folderLookup[folder.id.toString()] ?? [],
  }));

  treeFromDb.push(...sourcesWithoutFolder);

  return { tree: treeFromDb };
};
