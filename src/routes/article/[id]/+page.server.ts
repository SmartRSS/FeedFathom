import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import container from '../../../container';
import type { Article } from '../../../types/article.type';

export const load = (async ({ params }) => {
    const article = await container.cradle.articlesRepository.getArticleByGuid(params.id);
    
    if (!article) {
        throw error(404, 'Article not found');
    }

    return {
        article
    };
}) satisfies PageServerLoad<{ article: Article }>; 