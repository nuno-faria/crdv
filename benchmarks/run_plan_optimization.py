#!/usr/bin/python3
# Creates and runs the shopping cart example to extract the plans.

import psycopg2
import argparse
import re
import os


def connect(host, port, database, user, password):
    conn = psycopg2.connect(host=host, port=port, dbname=database, user=user, password=password)
    conn.autocommit = False
    cursor = conn.cursor()
    return conn, cursor


# creates the table and view, and populates with random data
def populate(cursor):
    cursor.execute('''
        CREATE TABLE shoppingCartPresent (
            cart_id bigint,
            product_id bigint,
            quantity int,
            op "char",
            site int,
            lts vclock,
            pts hlc,
            PRIMARY KEY(cart_id, product_id)
        )
    ''')

    cursor.execute('''
        CREATE VIEW ShoppingCartLww AS
        SELECT cart_id, product_id, quantity
        FROM (
            SELECT cart_id, product_id, quantity, op,
                rank() OVER (
                    PARTITION BY cart_id, product_id
                    ORDER BY pts DESC, site
                ) AS rank
            FROM ShoppingCartPresent
        ) t
        WHERE rank = 1
            AND op != 'r'
    ''')

    cursor.execute('''
        INSERT INTO shoppingCartPresent
        SELECT (random() * 100000000000)::bigint, (random() * 1000000)::bigint, (random() * 10)::int,
            'a', 1, '{1, 0, 0}', (currentTimeMillis(), 1)::hlc
        FROM generate_series(1, 1000000);
    ''')

    cursor.execute('ANALYZE')
    cursor.execute('SET random_page_cost = 4')


# query1: return all products in some shopping cart
def query1(cursor):
    cursor.execute('''
        SELECT cart_id
        FROM shoppingCartPresent
        ORDER BY random()
        LIMIT 1
    ''')
    id = cursor.fetchone()[0]

    cursor.execute('''
        EXPLAIN ANALYZE
        SELECT product_id, quantity
        FROM ShoppingCartLww
        WHERE cart_id = %s
    ''', (id,))

    return [row[0] for row in cursor.fetchall()]


# query2: return all shopping carts that contain at least one product in some defined range
def query2(cursor):
    cursor.execute('''
        EXPLAIN ANALYZE
        SELECT DISTINCT cart_id
        FROM ShoppingCartLww
        WHERE product_id BETWEEN 555000 AND 556000;
    ''')
    return [row[0] for row in cursor.fetchall()]


# runs and returns the plans of both queries
def run(cursor):
    populate(cursor)

    plan1 = query1(cursor)
    plan2 = query2(cursor)

    # create index on product ids to optimize the second query
    cursor.execute('CREATE INDEX shopping_p_id_idx ON shoppingCartPresent (product_id)')
    plan2Opt = query2(cursor)

    return plan1, plan2, plan2Opt


# trims extra information from the plan, returning only the operators
def simplifyPlan(plan):
    simplePlan = []

    for line in plan:
        simpleLine = re.sub(r'\s+ \(cost=.*', '', line) # costs
        simpleLine = re.sub(r'^\s+.*?:.*', '', simpleLine) # operator details
        simpleLine = re.sub(r'on t', '', simpleLine) # "on t" scans
        simpleLine = re.sub(r'->  ', '    ', simpleLine) # arrows
        simpleLine = re.sub(r'\s{6}', ' ', simpleLine) # compress whitespace
        simpleLine = re.sub(r'Planning Time:.*', '', simpleLine) # planning time

        match = re.match(r'Execution (Time:.*)', simpleLine)
        # if execution time, append it at the start
        if match:
            simplePlan[0] += f' ({match[1]})'
        # otherwise, add to the plan
        elif simpleLine != '':
            simplePlan.append(simpleLine)

    return '\n'.join(simplePlan)


def main():
    parser = argparse.ArgumentParser(formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument('-H', '--host', type=str, help='Database host', action='store', default='localhost')
    parser.add_argument('-p', '--port', type=str, help='Database port', action='store', default='5432')
    parser.add_argument('-d', '--database', type=str, help='Database name', action='store', default='testdb')
    parser.add_argument('-u', '--user', type=str, help='Username', action='store', default='postgres')
    parser.add_argument('-P', '--password', type=str, help='Password', action='store', default='postgres')
    args = parser.parse_args()

    conn, cursor = connect(args.host, args.port, args.database, args.user, args.password)
    plan1, plan2, plan2Opt = run(cursor)
    conn.rollback()

    os.makedirs('results/plans', exist_ok=True)

    with open('results/plans/plan1.txt', 'w') as f:
        f.write(simplifyPlan(plan1))

    with open('results/plans/plan2.txt', 'w') as f:
        f.write(simplifyPlan(plan2))

    with open('results/plans/plan2opt.txt', 'w') as f:
        f.write(simplifyPlan(plan2Opt))


if __name__ == '__main__':
    main()
