export class Article {
  group?: string;

  constructor(
    public readonly id: number,
    public readonly guid: string,
    public readonly sourceId: number,
    public readonly title: string,
    public readonly url: string,
    public readonly author: string,
    public readonly publishedAt: Date | null,
    public readonly createdAt?: Date | null,
    public readonly updatedAt?: Date | null,
    public readonly content?: string,
  ) {}
}
