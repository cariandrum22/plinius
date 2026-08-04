## Context

You are reviewing a Django + Django REST Framework service that powers the "order history" page of a B2B ordering platform. The endpoint returns a customer's recent orders, each with its line items and the product referenced by each line item, plus the customer's account name.

The models are:

```python
# models.py
from django.db import models


class Customer(models.Model):
    name = models.CharField(max_length=200)
    account_tier = models.CharField(max_length=50)


class Product(models.Model):
    sku = models.CharField(max_length=64, unique=True)
    name = models.CharField(max_length=200)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)


class Order(models.Model):
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="orders")
    placed_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=30, default="pending")


class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField()
```

The view and serializer:

```python
# views.py
from rest_framework.generics import ListAPIView
from rest_framework.permissions import IsAuthenticated

from .models import Order
from .serializers import OrderSerializer


class OrderHistoryView(ListAPIView):
    serializer_class = OrderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Order.objects.filter(
            customer_id=self.request.user.customer_id
        ).order_by("-placed_at")[:50]
```

```python
# serializers.py
from rest_framework import serializers

from .models import Order


class OrderItemSerializer(serializers.Serializer):
    product_sku = serializers.CharField(source="product.sku")
    product_name = serializers.CharField(source="product.name")
    unit_price = serializers.DecimalField(source="product.unit_price", max_digits=10, decimal_places=2)
    quantity = serializers.IntegerField()
    line_total = serializers.SerializerMethodField()

    def get_line_total(self, obj):
        return obj.product.unit_price * obj.quantity


class OrderSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    status = serializers.CharField()
    placed_at = serializers.DateTimeField()
    customer_name = serializers.CharField(source="customer.name")
    items = OrderItemSerializer(source="items.all", many=True)
```

## Observed symptom

This endpoint was fine in staging with seeded test accounts that had only a handful of orders. In production, for customers with a long order history, on-call has observed:

- Response time for `GET /api/orders/history` grows roughly linearly with the number of orders and items returned, from single-digit milliseconds for light accounts to well over a second for accounts near the 50-order page cap with several items per order.
- The Postgres slow-query log and connection pool metrics show a large number of small, near-identical `SELECT` statements per request against `orders_customer`, `orders_product`, and `orders_orderitem` — proportional to the number of orders and items on the page, not a constant number — even though the endpoint always returns at most 50 orders.
- Database CPU and connection-pool saturation increase noticeably during peak hours when many customers with large histories hit this endpoint concurrently, even though the total rows returned per request are modest.
- APM tracing attributes the majority of the endpoint's wall-clock time to database round trips rather than serialization or application logic.

## Deliverable

Provide:

1. A precise diagnosis of the query pattern causing this behavior, identifying exactly which attribute accesses in the serializer trigger additional database round trips, and why the number of queries scales with the number of orders and items rather than staying constant.
2. An explanation of why this was invisible in staging (light seed data) but severe in production (long order histories), tying the mechanism to the observed metrics (query count, DB CPU, connection pool pressure, wall-clock time dominated by DB round trips).
3. A concrete remediation plan. If more than one viable approach exists (e.g., eager loading via `select_related`/`prefetch_related`, restructuring the query with `Prefetch` objects and field projection via `only()`/`values()`, denormalizing frequently-read fields, or introducing a read cache), name the credible options and recommend one, explaining the trade-offs you are accepting — over-fetching versus under-fetching, query plan complexity, memory footprint per request, staleness if caching is introduced, and any impact on write-path complexity or maintainability.
4. A measurement strategy to confirm the fix actually resolves the problem and to prevent regression: how you would verify the query count and latency before and after the change, and how you would guard against this pattern reappearing as the codebase evolves.
