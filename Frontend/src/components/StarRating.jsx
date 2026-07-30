export default function StarRating({
  value,
  disabled = false,
  onRate,
  onClear,
  error = '',
}) {
  return (
    <div className="star-rating">
      <div className="star-rating__controls" role="group" aria-label="Your resource rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            className={`star-rating__star ${star <= (value || 0) ? 'star-rating__star--filled' : ''}`}
            aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
            aria-pressed={value === star}
            disabled={disabled}
            onClick={() => onRate(star)}
          >
            <span aria-hidden="true">★</span>
          </button>
        ))}
      </div>
      {value != null && (
        <button
          type="button"
          className="star-rating__clear"
          disabled={disabled}
          onClick={onClear}
        >
          Clear rating
        </button>
      )}
      {error && <div className="star-rating__error" role="status">{error}</div>}
    </div>
  );
}
