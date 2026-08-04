A team asks you to review the data-access functions below, used by a reporting API. Users can search records and sort results. The functions build SQL directly.

```python
def search_users(conn, q, sort_col, sort_dir):
    sql = (
        "SELECT id, name, email FROM users "
        f"WHERE name LIKE '%{q}%' "
        f"ORDER BY {sort_col} {sort_dir}"
    )
    return conn.execute(sql).fetchall()

def get_report(conn, tenant_id, filters):
    where = " AND ".join(f"{k} = '{v}'" for k, v in filters.items())
    sql = f"SELECT * FROM reports WHERE tenant_id = '{tenant_id}' AND {where}"
    return conn.execute(sql).fetchall()
```

`q`, `sort_col`, `sort_dir`, `tenant_id`, and the `filters` keys and values all originate from HTTP request parameters.

Review this code for injection defects. Explain the vulnerability class precisely, which inputs are dangerous, and why parameterization alone does not solve every case here (note the identifier positions such as the sort column and direction). Then specify the correct approach for each category of input, including how to handle values, column names, and sort direction safely. Point to the specific lines and give concrete, idiomatic fixes rather than general advice.
