from pydantic import BaseModel, Field


class User(BaseModel):
    name: str = Field(examples=["asliddin"])
    team: str = Field(examples=["backend"])
