"""Caller-scoped server-resource rating mutations."""

from typing import Any, Protocol

from .schemas import Rag2RatingSummary


class CallerScopedRatingClient(Protocol):
    async def rpc(self, function_name: str, payload: dict[str, Any]) -> Any: ...


class Rag2RatingError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _rating_summary(rows: Any) -> Rag2RatingSummary:
    if not isinstance(rows, list) or len(rows) != 1:
        raise Rag2RatingError(500, "Rating operation returned an invalid result.")
    try:
        summary = Rag2RatingSummary.model_validate(rows[0])
    except Exception as error:
        raise Rag2RatingError(
            500,
            "Rating operation returned an invalid result.",
        ) from error
    if (
        (summary.rating_count == 0 and summary.average_rating is not None)
        or (summary.rating_count > 0 and summary.average_rating is None)
        or (
            summary.current_user_rating is not None
            and summary.rating_count == 0
        )
    ):
        raise Rag2RatingError(500, "Rating operation returned an invalid summary.")
    return summary


async def set_resource_rating(
    client: CallerScopedRatingClient,
    resource_id: str,
    rating: int,
) -> Rag2RatingSummary:
    if (
        isinstance(rating, bool)
        or not isinstance(rating, int)
        or rating < 1
        or rating > 5
    ):
        raise Rag2RatingError(422, "Rating must be between 1 and 5.")
    try:
        rows = await client.rpc(
            "set_server_resource_rating",
            {
                "p_resource_id": resource_id,
                "p_rating": rating,
            },
        )
    except Exception as error:
        status_code = getattr(error, "status_code", None)
        if status_code in {403, 404, 422}:
            raise Rag2RatingError(status_code, "Resource rating was rejected.") from error
        raise Rag2RatingError(500, "Resource rating could not be saved.") from error
    return _rating_summary(rows)


async def delete_resource_rating(
    client: CallerScopedRatingClient,
    resource_id: str,
) -> Rag2RatingSummary:
    try:
        rows = await client.rpc(
            "delete_server_resource_rating",
            {"p_resource_id": resource_id},
        )
    except Exception as error:
        status_code = getattr(error, "status_code", None)
        if status_code in {403, 404}:
            raise Rag2RatingError(status_code, "Resource rating was rejected.") from error
        raise Rag2RatingError(500, "Resource rating could not be removed.") from error
    return _rating_summary(rows)
