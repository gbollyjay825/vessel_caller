from typing import Any, cast

from django.core.paginator import Page
from rest_framework.pagination import PageNumberPagination
from rest_framework.request import Request
from rest_framework.response import Response


class StandardPagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "pageSize"
    max_page_size = 100

    def get_paginated_response(self, data):
        page = cast(Page[Any], self.page)
        request = cast(Request, self.request)
        return Response(
            {
                "results": data,
                "count": page.paginator.count,
                "page": page.number,
                "pageSize": self.get_page_size(request),
            }
        )
