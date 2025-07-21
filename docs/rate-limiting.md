# Strategy-Specific Rate Limiting

FeedFathom now supports strategy-specific rate limiting that allows different strategies to define their own rate limiting rules.

## How It Works

Each strategy can optionally implement a `getRateLimitConfig()` method that returns a `RateLimitConfig` object:

```typescript
interface RateLimitConfig {
  /** Minimum delay between requests in milliseconds */
  minDelayMs: number;
  /** Maximum delay between requests in milliseconds (for randomization) */
  maxDelayMs?: number;
  /** Whether to randomize the delay between min and max */
  randomize?: boolean;
}
```

## Current Strategy Rate Limits

### Facebook Strategy
- **Minimum delay**: 1 minute
- **Maximum delay**: 5 minutes
- **Randomization**: Enabled
- **Result**: Random delay between 1-5 minutes between requests

### Generic Feed Strategy
- **Minimum delay**: 30 seconds
- **Maximum delay**: 2 minutes
- **Randomization**: Enabled
- **Result**: Random delay between 30 seconds - 2 minutes between requests

### JSON Feed Strategy
- **Rate limiting**: None (uses default system rate limiting)

## Implementation Details

1. **Per-Domain Per-Strategy**: Rate limits are tracked separately for each domain and strategy combination
2. **Redis Storage**: Rate limit state is stored in Redis with keys like `rateLimitUntil:domain.com:StrategyName`
3. **Randomization**: When `randomize` is true, delays are randomized between min and max values
4. **Fallback**: Strategies without rate limit config use the default system rate limiting

## Example Usage

```typescript
// Facebook strategy will enforce 1-5 minute delays
const facebookStrategy = new FacebookFeedStrategy();
const config = facebookStrategy.getRateLimitConfig();
// config = { minDelayMs: 60000, maxDelayMs: 300000, randomize: true }

// Generic strategy will enforce 30s-2min delays
const genericStrategy = new GenericFeedStrategy();
const config = genericStrategy.getRateLimitConfig();
// config = { minDelayMs: 30000, maxDelayMs: 120000, randomize: true }
```

## Benefits

- **Respectful crawling**: Different strategies can have different rate limits based on target site requirements
- **Randomization**: Prevents predictable request patterns
- **Flexibility**: Easy to adjust rate limits per strategy
- **Backward compatibility**: Existing strategies without rate limit config continue to work normally 